import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { App, Stack } from "aws-cdk-lib";
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
