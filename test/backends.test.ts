import assert from "node:assert/strict";
import { test } from "node:test";
import { backends, choice, decide, DecideError, noul, score, systemOne } from "../src/index.ts";
import { fakeFetch, JEV_MUDDY_TICKET, jsonResponse } from "./helpers.ts";

const questions = {
  team: choice("Which team?", { account: "login", technical: "bugs", billing: "charges" }),
  severity: score("How severe?", ["cosmetic", "workaround exists", "blocking"]),
  refund: noul("Money back?"),
};

test("end to end: typed answers, request shape, auth header, usage", async () => {
  const { fetch, calls } = fakeFetch(jsonResponse(JEV_MUDDY_TICKET));
  const d = decide({ backend: systemOne({ baseUrl: "https://example.test/prefix/", model: "m", apiKey: "k", fetch }) });
  const r = await d.ask("two charges", questions);

  assert.equal(r.answers.team.choice, "billing");
  assert.equal(r.answers.severity.score, 1.15);
  assert.equal(r.answers.refund.verdict, false);
  assert.equal(r.usage?.inputTokens, 447);
  assert.equal(r.gate("team", { act: 0.9, review: 0.6 }), "review");

  const call = calls[0]!;
  assert.equal(call.url, "https://example.test/prefix/v1/systemone"); // base path preserved
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers["authorization"], "Bearer k");
  const body = JSON.parse(String(call.init.body));
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
});

test("keyless backends (self-hosted) send no authorization header", async () => {
  const { fetch, calls } = fakeFetch(jsonResponse({ answers: { refund: { noul: 0.9 } } }));
  await decide({ backend: systemOne({ baseUrl: "http://localhost:8000", model: "von-1.0.0", fetch }) }).ask("x", { refund: noul("?") });
  assert.equal((calls[0]!.init.headers as Record<string, string>)["authorization"], undefined);
});

test("backends.gateway posts to the bare stack-output URL with a gateway label", async () => {
  const { fetch, calls } = fakeFetch(jsonResponse(JEV_MUDDY_TICKET));
  await decide({ backend: backends.gateway("https://g.test.lambda-url.us-east-1.on.aws/", { fetch }) })
    .ask("two charges", questions);

  assert.equal(calls[0]!.url, "https://g.test.lambda-url.us-east-1.on.aws/v1/systemone");
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.model, "gateway", "the label is fixed; the gateway fixes the real model itself");
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
});

test("backends.gateway sends no authorization header, even with a provider key in the environment", async (t) => {
  // The whole point: a deployed gateway holds the upstream key, and an authorization header
  // would overwrite the SigV4 signature that fetch puts in that same header.
  t.after(() => { delete process.env["OPENROUTER_API_KEY"]; });
  process.env["OPENROUTER_API_KEY"] = "leaked-upstream-key";

  const { fetch, calls } = fakeFetch(jsonResponse({ answers: { refund: { noul: 0.9 } } }));
  await decide({ backend: backends.gateway("https://g.test", { fetch }) }).ask("x", { refund: noul("?") });

  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["authorization"], undefined);
  assert.doesNotMatch(JSON.stringify(headers), /leaked-upstream-key/);
  assert.doesNotMatch(String(calls[0]!.init.body), /leaked-upstream-key/);
});

test("backends.gateway strips an apiKey even from an untyped caller", async () => {
  const { fetch, calls } = fakeFetch(jsonResponse({ answers: { refund: { noul: 0.9 } } }));
  // @ts-expect-error apiKey is deliberately excluded from GatewayOptions
  const backend = backends.gateway("https://g.test", { apiKey: "would-clobber-sigv4", fetch });

  assert.equal(backend.name, "gateway");
  await decide({ backend }).ask("x", { refund: noul("?") });
  assert.equal((calls[0]!.init.headers as Record<string, string>)["authorization"], undefined);
});

test("retries 529 then succeeds; honours retry-after", async () => {
  const { fetch, calls } = fakeFetch(jsonResponse({}, 529, { "retry-after": "0" }), jsonResponse(JEV_MUDDY_TICKET));
  const r = await decide({ backend: systemOne({ baseUrl: "https://x.test", model: "m", fetch }) }).ask("s", questions);
  assert.equal(calls.length, 2);
  assert.equal(r.answers.team.choice, "billing");
});

test("auth failures are not retried", async () => {
  const { fetch, calls } = fakeFetch(new Response("nope", { status: 403 }));
  await assert.rejects(
    decide({ backend: systemOne({ baseUrl: "https://x.test", model: "m", fetch }) }).ask("s", questions),
    (e: unknown) => e instanceof DecideError && e.code === "auth" && e.status === 403,
  );
  assert.equal(calls.length, 1);
});

test("gives up after retries with a typed error", async () => {
  const { fetch, calls } = fakeFetch(jsonResponse({}, 503));
  await assert.rejects(
    decide({ backend: systemOne({ baseUrl: "https://x.test", model: "m", retries: 1, fetch }) }).ask("s", questions),
    (e: unknown) => e instanceof DecideError && e.code === "upstream" && e.retryable,
  );
  assert.equal(calls.length, 2);
});

test("timeouts surface as timeout errors", async () => {
  // AbortSignal.timeout() timers are unref'd, so hold the loop open like a real socket would.
  const slow: typeof fetch = (_u, init) => new Promise((_res, rej) => {
    const keepAlive = setInterval(() => {}, 1_000);
    init?.signal?.addEventListener("abort", () => { clearInterval(keepAlive); rej(init.signal!.reason); });
  });
  await assert.rejects(
    decide({ backend: systemOne({ baseUrl: "https://x.test", model: "m", timeoutMs: 20, retries: 0, fetch: slow }) }).ask("s", questions),
    (e: unknown) => e instanceof DecideError && e.code === "timeout",
  );
});

test("a missing answer for a question is a malformed_response", async () => {
  const { fetch } = fakeFetch(jsonResponse({ answers: {} }));
  await assert.rejects(
    decide({ backend: systemOne({ baseUrl: "https://x.test", model: "m", fetch }) }).ask("s", questions),
    (e: unknown) => e instanceof DecideError && e.code === "malformed_response",
  );
});

test("presets point at the documented endpoints", () => {
  assert.equal(backends.typesafe().model, "jev-1.13");
  assert.equal(backends.openrouter().model, "typesafe/jev-1.13");
  assert.equal(backends.vercel({ model: "typesafe-ai/jev" }).name, "vercel");
});

test("the request body matches the /v1/systemone schema OpenRouter validates", async () => {
  // Verified live against https://openrouter.ai/api/v1/systemone with typesafe/jev-1.13: it
  // rejects anything else with a per-field zod error. Each question needs `type` as an
  // explicit discriminator and `instructions` + `criteria` at the top level (not nested),
  // and `criteria` for a choice is a record of option keys to descriptions.
  const { fetch, calls } = fakeFetch(jsonResponse(JEV_MUDDY_TICKET));
  await decide({ backend: backends.openrouter({ fetch }) }).ask("two charges", questions);

  assert.equal(calls[0]!.url, "https://openrouter.ai/api/v1/systemone");
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
  assert.equal(body["model"], "typesafe/jev-1.13");
  assert.equal(body["questions"]["team"]["type"], "choice");
  assert.equal(body["questions"]["team"]["instructions"], "Which team?");
  assert.deepEqual(body["questions"]["team"]["criteria"], { account: "login", technical: "bugs", billing: "charges" });
  assert.equal(body["questions"]["severity"]["type"], "score");
  assert.deepEqual(body["questions"]["severity"]["criteria"], ["cosmetic", "workaround exists", "blocking"]);
  assert.equal(body["questions"]["refund"]["type"], "noul");
  assert.equal(body["questions"]["refund"]["instructions"], "Money back?");
});
