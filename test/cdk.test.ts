import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { App, Duration, Stack } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { DecisionGateway, type DecisionGatewayProps } from "../src/cdk/index.ts";
import { apiKeySsmFromEnv, backendFromEnv, loadDotEnv } from "../src/cdk/env.ts";

function build(props: DecisionGatewayProps = {}) {
  const stack = new Stack(new App(), "T", { env: { account: "123456789012", region: "eu-north-1" } });
  const gateway = new DecisionGateway(stack, "Jev", props);
  return { stack, gateway };
}

const SSM = { apiKeySsmParameter: "/lambda-decide/jev/api-key" };

test("defaults: IAM-auth URL, Node 24 on arm64, no secret and no manual post-deploy step", () => {
  const template = Template.fromStack(build().stack);
  template.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "nodejs24.x", Architectures: ["arm64"], Handler: "entry.handler", MemorySize: 256,
  });
  template.hasResourceProperties("AWS::Lambda::Url", { AuthType: "AWS_IAM" });
  template.resourceCountIs("AWS::SecretsManager::Secret", 0); // the key lives in SSM, not Secrets Manager
  const outputs = template.toJSON()["Outputs"] ?? {};
  assert.deepEqual(Object.keys(outputs), ["GatewayUrl"], "a stable, greppable output key callers can query");
});

test("the key is read from the SSM parameter you name, by ARN, and never from a secret", () => {
  const template = Template.fromStack(build(SSM).stack);
  // SSM parameter ARNs drop the leading slash, unlike the parameter name you pass in.
  const [policy] = Object.values(template.findResources("AWS::IAM::Policy"));
  const doc = JSON.stringify(policy?.Properties.PolicyDocument);
  assert.match(doc, /ssm:GetParameter/);
  assert.match(doc, /parameter\/lambda-decide\/jev\/api-key/);
  assert.doesNotMatch(doc, /:\*\}/, "the grant is scoped to this one parameter, not all of them");
  template.resourceCountIs("AWS::SecretsManager::Secret", 0);
  // The parameter name reaches the function as config, so the handler knows what to read.
  const [fn] = Object.values(template.findResources("AWS::Lambda::Function"));
  assert.match(JSON.stringify(fn?.Properties.Environment), /lambda-decide\/jev\/api-key/);
});

test("the SSM grant is exactly GetParameter on that one parameter", () => {
  // The handler calls GetParameter and nothing else, so GetParameters/GetParametersByPath were
  // pure over-grant: two more ways for this role to read secrets it has no business seeing.
  const template = Template.fromStack(build(SSM).stack);
  const [policy] = Object.values(template.findResources("AWS::IAM::Policy"));
  const statements: { Action: unknown }[] = policy?.Properties.PolicyDocument.Statement;
  const ssm = statements.filter((s) => JSON.stringify(s.Action).includes("ssm:"));
  assert.deepEqual(ssm.map((s) => s.Action), ["ssm:GetParameter"]);
  assert.doesNotMatch(JSON.stringify(policy?.Properties.PolicyDocument), /kms:/, "a customer-managed key needs kms:Decrypt, which the caller grants");
});

test("timeoutMs defaults so the whole retry ladder fits inside the function timeout", () => {
  // 8000ms x 3 attempts = 24s of a 30s invocation. Previously the gateway inherited the client's
  // own 15s default, i.e. 45s of upstream attempts inside 30s: the function timed out first and
  // the caller saw an opaque 502 rather than the gateway's 504.
  const [fn] = Object.values(Template.fromStack(build().stack).findResources("AWS::Lambda::Function"));
  const config = JSON.parse((fn?.Properties.Environment as { Variables: Record<string, string> }).Variables["DECIDE_CONFIG"]!);
  assert.equal(config.timeoutMs, 8000);
  assert.equal(fn?.Properties.Timeout, 30);
  assert.ok(config.timeoutMs * 3 < (fn?.Properties.Timeout as number) * 1000);
});

test("an explicit timeoutMs reaches the function, and the default scales with a longer timeout", () => {
  const envOf = (props: DecisionGatewayProps) => {
    const [fn] = Object.values(Template.fromStack(build(props).stack).findResources("AWS::Lambda::Function"));
    return JSON.parse((fn?.Properties.Environment as { Variables: Record<string, string> }).Variables["DECIDE_CONFIG"]!).timeoutMs;
  };
  assert.equal(envOf({ timeoutMs: 2500 }), 2500);
  assert.equal(envOf({ timeout: Duration.seconds(60) }), 16000); // floor(60000 * 0.8 / 3)
  assert.equal(envOf({ timeout: Duration.seconds(15) }), 4000); // floor(15000 * 0.8 / 3)
});

test("a timeoutMs that cannot outlast its own retries fails at synth, naming the budget", () => {
  // A synth-time throw beats a deploy-time gateway that returns 502 on every slow upstream.
  assert.throws(() => build({ timeoutMs: 11_000 }), /11000 x 3 upstream attempts \(2 retries\) = 33000ms/);
  assert.throws(() => build({ timeoutMs: 10_000 }), /not below the 30000ms function timeout/);
  assert.throws(() => build({ timeoutMs: 15_000, timeout: Duration.seconds(30) }), /not below the 30000ms/);
  assert.doesNotThrow(() => build({ timeoutMs: 9_999 })); // 29997ms: the boundary is strictly below
  assert.throws(() => build({ timeout: Duration.seconds(9), timeoutMs: 3_000 }), /not below the 9000ms/);
  assert.doesNotThrow(() => build({ timeout: Duration.seconds(9), timeoutMs: 2_999 })); // 8997ms
  assert.throws(() => build({ timeoutMs: 0 }), /must be a positive number/);
  assert.throws(() => build({ timeoutMs: Number.NaN }), /must be a positive number/);
});

test("no apiKeySsmParameter warns at synth instead of deploying a keyless gateway", () => {
  Annotations.fromStack(build().stack).hasWarning("*", Match.stringLikeRegexp("no apiKeySsmParameter"));
});

test("no build step: the asset ships sources, the .mjs shim, and a type:module manifest", () => {
  // There is no build, so the zip is src/ verbatim. Lambda only resolves .js/.mjs/.cjs
  // handlers, hence entry.mjs; and src/ is the zip root, so src/package.json is the nearest
  // manifest telling nodejs24.x that the .ts files are ES modules. Losing either breaks cold start.
  const dir = fileURLToPath(new URL("../src", import.meta.url));
  assert.ok(existsSync(join(dir, "entry.mjs")), "entry.mjs shim is committed");
  assert.ok(existsSync(join(dir, "handler/index.ts")), "handler source ships as-is");
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))["type"], "module");
  assert.ok(!existsSync(join(dir, "../dist")), "nothing is built into dist/");

  const template = Template.fromStack(build().stack);
  const [fn] = Object.values(template.findResources("AWS::Lambda::Function"));
  assert.equal((fn?.Properties.Handler), "entry.handler");
});

test("config reaches the function as JSON; reserved concurrency applies", () => {
  const template = Template.fromStack(build({
    backend: { baseUrl: "http://von.internal:8000", model: "von-1.0.0" },
    redact: ["email"], cache: { ttlSeconds: 60 }, reservedConcurrency: 5,
  }).stack);
  template.hasResourceProperties("AWS::Lambda::Function", { ReservedConcurrentExecutions: 5 });
  const [fn] = Object.values(template.findResources("AWS::Lambda::Function"));
  const env = JSON.stringify(fn?.Properties.Environment);
  assert.match(env, /von-1\.0\.0/);
  assert.match(env, /http:\/\/von\.internal:8000/);
  assert.match(env, /ttlSeconds/);
});

test("auth none warns at synth time", () => {
  Annotations.fromStack(build({ auth: "none" }).stack).hasWarning("*", Match.stringLikeRegexp("auth is 'none'"));
});

test("grantInvoke gives callers lambda:InvokeFunctionUrl", () => {
  const { stack, gateway } = build(SSM);
  gateway.grantInvoke(new Role(stack, "Caller", { assumedBy: new ServicePrincipal("lambda.amazonaws.com") }));
  Template.fromStack(stack).hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: "lambda:InvokeFunctionUrl" })]) },
  });
});

test("env vars pick the backend and the SSM parameter", () => {
  assert.deepEqual(backendFromEnv({}), { preset: "openrouter" });
  assert.deepEqual(backendFromEnv({ DECIDE_BACKEND: "vercel" }), { preset: "vercel" });
  assert.deepEqual(backendFromEnv({ DECIDE_BACKEND: "typesafe", DECIDE_BACKEND_MODEL: "jev-1.13" }), {
    preset: "typesafe", model: "jev-1.13",
  });
  assert.deepEqual(backendFromEnv({ DECIDE_BACKEND_URL: "http://von.internal:8000", DECIDE_BACKEND_MODEL: "von-1.0.0" }), {
    baseUrl: "http://von.internal:8000", model: "von-1.0.0",
  });
  assert.equal(apiKeySsmFromEnv({ DECIDE_API_KEY_SSM: "/a/b" }), "/a/b");
  assert.equal(apiKeySsmFromEnv({}), undefined);
  assert.throws(() => backendFromEnv({ DECIDE_BACKEND: "llama" }), /DECIDE_BACKEND must be one of/);
  assert.throws(() => backendFromEnv({ DECIDE_BACKEND_URL: "http://x" }), /DECIDE_BACKEND_MODEL is required/);
});

test("the caller's gateway model never leaks into the deployed backend model", () => {
  // A caller-side label must never reach DECIDE_CONFIG, or the gateway would ask Jev for a
  // model literally named "gateway". The caller-side label now lives in backends.gateway().
  assert.deepEqual(backendFromEnv({ DECIDE_BACKEND: "typesafe", GATEWAY_MODEL: "gateway" }), { preset: "typesafe" });
  assert.deepEqual(
    backendFromEnv({ DECIDE_BACKEND_URL: "https://api.test", DECIDE_BACKEND_MODEL: "von-1.0.0", GATEWAY_MODEL: "gateway" }),
    { baseUrl: "https://api.test", model: "von-1.0.0" },
  );
});

test("loadDotEnv parses values and never overrides the real environment", (t) => {
  const path = join(tmpdir(), `decide-dotenv-${process.pid}-${t.name}.env`);
  writeFileSync(path, [
    "# a comment",
    "",
    "APP_URL=https://gateway.test/",
    'DECIDE_MODEL="quoted model"',
    "export DECIDE_BACKEND=typesafe",
    "EMPTY=",
    "not a pair",
  ].join("\n"));
  t.after(() => rmSync(path, { force: true }));

  const env: NodeJS.ProcessEnv = { DECIDE_BACKEND: "vercel" }; // real environment wins
  loadDotEnv(path, env);
  assert.equal(env["APP_URL"], "https://gateway.test/");
  assert.equal(env["DECIDE_MODEL"], "quoted model");
  assert.equal(env["DECIDE_BACKEND"], "vercel", "already-set variable is not overwritten");
  assert.equal(env["EMPTY"], "");
  assert.doesNotThrow(() => loadDotEnv(join(tmpdir(), "definitely-not-here.env"), env)); // missing file is fine
});
