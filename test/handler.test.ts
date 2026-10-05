import assert from "node:assert/strict";
import { test } from "node:test";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { Backend, BackendRequest, BackendResponse } from "../src/index.ts";
import { createHandler } from "../src/handler/index.ts";
import { JEV_MUDDY_TICKET, fakeFetch, jsonResponse } from "./helpers.ts";

const upstream: BackendResponse = {
  model: JEV_MUDDY_TICKET.model, id: "gen-1",
  answers: { team: JEV_MUDDY_TICKET.answers.team, refund: JEV_MUDDY_TICKET.answers.refund },
  usage: { inputTokens: 447, outputTokens: 69 },
};

function setup(config: Partial<Parameters<typeof createHandler>[0]["config"]> = {}) {
  const seen: BackendRequest[] = [];
  const logs: string[] = [];
  const backend: Backend = { name: "fake", model: "fake-1", async evaluate(r) { seen.push(r); return upstream; } };
  const handler = createHandler({ config: { backend: { preset: "openrouter" }, ...config }, backend, log: (l) => logs.push(l) });
  return { seen, logs, handler };
}

const event = (body: unknown, method = "POST"): APIGatewayProxyEventV2 => ({
  requestContext: { http: { method }, requestId: "req-1" },
  body: typeof body === "string" ? body : JSON.stringify(body),
  isBase64Encoded: false,
} as unknown as APIGatewayProxyEventV2);

const goodBody = {
  state: "I was charged twice. Reach me at jane@example.com or 4111 1111 1111 1111.",
  questions: {
    team: { type: "choice", instructions: "Which team?", criteria: { account: "login", technical: "bugs", billing: "charges" } },
    refund: { type: "noul", instructions: "Money back?" },
  },
};

test("happy path: upstream-compatible answers plus gates and gateway meta", async () => {
  const { handler } = setup();
  const res = await handler(event({ ...goodBody, gate: { team: { act: 0.9, review: 0.6 } } }));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body as string);
  assert.equal(body.answers.team.choice, "billing");
  assert.deepEqual(body.gates, { team: "review" });
  assert.equal(body.usage.input_tokens, 447);
  assert.equal(body.gateway.cached, false);
});

test("redacts state before it leaves, and never logs the state", async () => {
  const { handler, seen, logs } = setup({ redact: ["email", "card"] });
  await handler(event(goodBody));
  const sent = String(seen[0]!.state);
  assert.match(sent, /\[REDACTED:email\]/);
  assert.match(sent, /\[REDACTED:card\]/);
  assert.doesNotMatch(sent, /jane@example\.com|4111/);
  const log = logs.join("\n");
  assert.doesNotMatch(log, /jane|charged twice|Which team/);
  assert.match(log, /"msg":"decision"/);
  assert.match(log, /"team":\{"type":"choice"/);
});

test("cache: identical requests hit once upstream; different state misses", async () => {
  const { handler, seen } = setup({ cache: { ttlSeconds: 60, maxEntries: 10 } });
  await handler(event(goodBody));
  const second = JSON.parse((await handler(event(goodBody))).body as string);
  assert.equal(second.gateway.cached, true);
  await handler(event({ ...goodBody, state: "different" }));
  assert.equal(seen.length, 2);
});

test("client-supplied model is ignored", async () => {
  const { handler, seen } = setup();
  await handler(event({ ...goodBody, model: "expensive-model" }));
  assert.equal(seen.length, 1); // backend alone decides the model
});

test("validation: 400 for bad json, missing state, bad questions, bad gates; 405 for GET", async () => {
  const { handler, seen } = setup();
  const bad: unknown[] = ["{nope", { questions: goodBody.questions }, { state: "x", questions: {} }, { ...goodBody, gate: { ghost: { act: 1, review: 0 } } }, { ...goodBody, gate: { team: { act: 0.5, review: 0.9 } } }];
  for (const b of bad) {
    const res = await handler(event(b));
    assert.equal(res.statusCode, 400, JSON.stringify(b));
  }
  assert.equal((await handler(event(goodBody, "GET"))).statusCode, 405);
  assert.equal(seen.length, 0, "nothing invalid reaches the upstream");
});

test("oversized body is rejected", async () => {
  const { handler } = setup({ maxBodyBytes: 100 });
  assert.equal((await handler(event(goodBody))).statusCode, 400);
});

test("config.timeoutMs is the upstream deadline, and gives up as a 504 timeout", async () => {
  // The construct writes timeoutMs into DECIDE_CONFIG so the client gives up before the function
  // does; ignored, this would burn the client's own 15s x 3 attempts and the caller would get
  // Lambda's timeout instead of a typed 504. The message naming 30ms is the proof it was used.
  const hanging: typeof fetch = (_u, init) => new Promise((_res, rej) => {
    const keepAlive = setInterval(() => {}, 1_000);
    init?.signal?.addEventListener("abort", () => { clearInterval(keepAlive); rej(init.signal!.reason); });
  });
  const logs: string[] = [];
  const res = await createHandler({
    config: { backend: { preset: "openrouter" }, timeoutMs: 30 },
    fetch: hanging,
    log: (l) => logs.push(l),
  })(event(goodBody));

  assert.equal(res.statusCode, 504);
  assert.equal(JSON.parse(res.body as string).error.type, "timeout");
  assert.match(logs.join(), /timed out after 30ms/);
});

test("upstream failures map to 5xx and do not leak upstream bodies", async () => {
  const backend: Backend = { name: "fake", model: "m", async evaluate() { throw new (await import("../src/index.ts")).DecideError("upstream", "secret upstream detail", { status: 500 }); } };
  const logs: string[] = [];
  const res = await createHandler({ config: { backend: { preset: "openrouter" } }, backend, log: (l) => logs.push(l) })(event(goodBody));
  assert.equal(res.statusCode, 502);
  assert.doesNotMatch(res.body as string, /secret upstream detail/);
  assert.match(logs.join(), /secret upstream detail/); // but it is in our logs
});

test("an unreadable SSM key is an auth error naming the parameter, not an internal 500", async () => {
  // GetParameter throws ParameterNotFoundException rather than returning empty. Unguarded, that
  // escaped as an unexpected error and the caller saw an opaque 500 with no clue what to fix.
  for (const [name, failure] of [
    ["ParameterNotFoundException", Object.assign(new Error("parameter not found"), { name: "ParameterNotFoundException" })],
    ["AccessDeniedException", Object.assign(new Error("denied"), { name: "AccessDeniedException" })],
  ] as const) {
    const logs: string[] = [];
    const res = await createHandler({
      config: { backend: { preset: "openrouter" }, apiKeySsm: "/lambda-decide/jev/api-key" },
      ssmSend: async () => { throw failure; },
      log: (l) => logs.push(l),
    })(event(goodBody));
    assert.equal(res.statusCode, 502, name);
    assert.match(res.body as string, /gateway upstream authentication failed/, name);
    assert.doesNotMatch(res.body as string, new RegExp(name), "the SDK error name stays in our logs");
    assert.match(logs.join(), new RegExp(name), "our logs say exactly which SSM failure it was");
    assert.match(logs.join(), /lambda-decide\/jev\/api-key/);
  }
});

test("a placeholder or empty SSM value is rejected, and a good one reaches the backend", async () => {
  // No fake backend here: the real one has to call the key reader, or nothing is tested.
  const withValue = (value?: string) => createHandler({
    config: { backend: { preset: "openrouter" }, apiKeySsm: "/k" },
    ssmSend: async () => (value === undefined ? {} : { Parameter: { Value: value } }),
    fetch: fakeFetch(jsonResponse(JEV_MUDDY_TICKET)).fetch,
  });
  for (const bad of [undefined, "", "   ", "REPLACE_ME"]) {
    assert.equal((await withValue(bad)(event(goodBody))).statusCode, 502, JSON.stringify(bad));
  }
  const res = await withValue("  sk-real-key\n")(event(goodBody));
  assert.equal(res.statusCode, 200, "a usable key lets the request through");
  assert.equal(JSON.parse(res.body as string).answers.team.choice, "billing");
});

test("the SSM key is read once and cached per execution environment", async () => {
  let reads = 0;
  const { fetch, calls } = fakeFetch(jsonResponse(JEV_MUDDY_TICKET));
  const handler = createHandler({
    config: { backend: { preset: "openrouter" }, apiKeySsm: "/k" },
    ssmSend: async () => { reads++; return { Parameter: { Value: "sk-key" } }; },
    fetch,
  });
  await handler(event(goodBody));
  await handler(event({ ...goodBody, state: "different" }));
  assert.equal(calls.length, 2, "both requests reached the upstream");
  assert.equal(reads, 1, "two requests, one SSM read");
  assert.equal((calls[0]!.init.headers as Record<string, string>)["authorization"], "Bearer sk-key");
});
