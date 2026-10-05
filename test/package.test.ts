import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * What a consumer actually installs, and what they run it with. `exports` points at the
 * TypeScript sources, and Node's type stripping refuses to run on anything under
 * node_modules — so the runtime you can `import` this with is a decision, not a detail.
 * These tests are the evidence behind that sentence in the README.
 */

const repo = fileURLToPath(new URL("..", import.meta.url));
const tsxCli = join(repo, "node_modules", "tsx", "dist", "cli.mjs");

/** A clean install: the published `files` list, at the path npm/bun would put them. */
function installed(root: string): void {
  const dir = join(root, "node_modules", "lambda-decide");
  cpSync(join(repo, "package.json"), join(dir, "package.json"));
  cpSync(join(repo, "src"), join(dir, "src"), { recursive: true });
}

/** The Lambda asset: src/ as the zip root, so /var/task is outside node_modules. */
function lambdaAsset(root: string): string {
  const dir = join(root, "var-task");
  cpSync(join(repo, "src"), dir, { recursive: true });
  rmSync(join(dir, "cdk"), { recursive: true, force: true }); // Code.fromAsset excludes it
  cpSync(join(repo, "package.json"), join(dir, "package.json"));
  return dir;
}

const run = (cmd: string, args: readonly string[], cwd: string) =>
  spawnSync(cmd, args as string[], { cwd, encoding: "utf8", timeout: 60_000 });

test("plain node cannot import the installed package: type stripping stops at node_modules", (t) => {
  assert.ok(Number(process.versions.node.split(".")[0]) >= 22, "these tests need the node the package declares: >=22.18");
  const root = mkdtempSync(join(tmpdir(), "decide-installed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  installed(root);

  // No flag re-enables stripping under node_modules, on 22 or on 24: not
  // --experimental-strip-types, not --experimental-transform-types.
  const res = run(process.execPath, ["--input-type=module", "-e", `await import("lambda-decide")`], root);

  assert.notEqual(res.status, 0, "a clean install is not importable by bare node");
  assert.match(res.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
});

/** A consumer that imports the client and runs one ask through an in-process backend. */
function consumer(root: string, extraImports: readonly string[] = []): void {
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  writeFileSync(join(root, "probe.ts"), [
    `import { decide, choice } from "lambda-decide";`,
    `import { createHandler } from "lambda-decide/handler";`,
    ...extraImports,
    `const d = decide({ backend: { name: "t", model: "m", evaluate: async () => ({ answers: { team: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 } } } }) } });`,
    `const r = await d.ask("x", { team: choice("Which?", { a: "1", b: "2" }) });`,
    `console.log(JSON.stringify([typeof createHandler, r.answers.team.choice${extraImports.length ? `, typeof DecisionGateway` : ""}]));`,
  ].join("\n"));
}

test("tsx can import the installed package, all three entry points", (t) => {
  const root = mkdtempSync(join(tmpdir(), "decide-installed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  installed(root);
  // The CDK entry point is the one subpath with peer dependencies; a consumer of it has them.
  for (const peer of ["aws-cdk-lib", "constructs"]) {
    symlinkSync(join(repo, "node_modules", peer), join(root, "node_modules", peer), "dir");
  }
  consumer(root, [`import { DecisionGateway } from "lambda-decide/cdk";`]);

  const res = run(process.execPath, [tsxCli, "probe.ts"], root);

  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout.trim()), ["function", "a", "function"]);
});

test("bun can import the installed package too", (t) => {
  const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (probe.error) {
    t.skip("bun is not on PATH here");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "decide-installed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  installed(root);
  consumer(root);

  const res = run("bun", ["probe.ts"], root);

  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout.trim()), ["function", "a"]);
});

test("the Lambda asset runs on bare node, because /var/task is not under node_modules", (t) => {
  const root = mkdtempSync(join(tmpdir(), "decide-var-task-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const asset = lambdaAsset(root);
  // Same entry the runtime invokes: entry.mjs -> handler/index.ts, config from DECIDE_CONFIG.
  writeFileSync(join(asset, "probe.mjs"), [
    `process.env.DECIDE_CONFIG = JSON.stringify({ backend: { baseUrl: "http://127.0.0.1:1/v1/systemone", model: "von-1.0.0" }, timeoutMs: 250 });`,
    `const { handler } = await import("./entry.mjs");`,
    `const res = await handler({ requestContext: { http: { method: "POST" }, requestId: "r1" }, body: JSON.stringify({ state: "s", questions: { refund: { type: "noul", instructions: "?" } } }) }, { awsRequestId: "r1" });`,
    `console.log("status", res.statusCode);`,
  ].join("\n"));

  const res = run(process.execPath, ["probe.mjs"], asset);

  // The upstream is a closed port, so this is the handler booting, parsing and erroring on its
  // own terms: 502 upstream, not a module resolution failure.
  assert.match(res.stdout, /^status 502/m, res.stderr);
  assert.doesNotMatch(res.stderr, /Type stripping|Cannot find module/);
});