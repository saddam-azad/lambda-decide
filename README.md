# lambda-decide

Typed, calibrated **System One** decisions (Choice / Score / Noul) for Node and AWS Lambda, plus a one-file CDK deploy for a gateway in front of any model that speaks the protocol.

The unit of compatibility here is the `/v1/systemone` protocol, not a model. **Jev** is the default instance and the only one this project tests against, but Von and Laya serve the identical wire format, and the [`Backend` interface](#bring-your-own-model) is open to anything else. Whichever you pick, the same Lambda gateway sits in front: it holds your API key, redacts PII before it leaves your account, caches, writes an audit log, and applies confidence gates. That matters most for a hosted model — Jev's weights are closed, so you can't run them yourself — but it's equally useful for self-hosted models you don't want every service calling directly.

## Install

```sh
bun add lambda-decide                      # client only
bun add lambda-decide aws-cdk-lib constructs aws-cdk tsx   # client + gateway
```

Node 22.18+, ESM only, TypeScript sources shipped as-is (see [Develop](#develop)).

## The client

```ts
import { decide, backends, choice, score, noul } from "lambda-decide";

const d = decide({ backend: backends.typesafe() }); // reads TYPESAFE_API_KEY

const r = await d.ask(ticketText, {
  team:     choice("Which team?", { billing: "charges, refunds", technical: "bugs, outages" }),
  severity: score("How severe?", ["cosmetic", "workaround exists", "blocking"]),
  refund:   noul("Is the customer asking for money back?"),
});

r.answers.team.choice;                          // "billing" | "technical"  (typed from your options)
r.answers.severity.score;                       // 1.15
r.answers.refund.verdict;                       // false
r.gate("team", { act: 0.9, review: 0.6 });       // "act" | "review" | "escalate"
r.usage?.inputTokens;
```

One `ask` call is one round trip for all questions. Answers are typed from the question definitions you pass in, so `r.answers.team.choice` narrows to your option keys with no casts.

### Backends

Any server implementing `POST /v1/systemone` works. All presets default `path` to `/v1/systemone` and take overrides for any `SystemOneOptions` field.

**Presets.** Note these are three hosting routes to the *same* Jev weights, not three models. Each provider names the version its own way, so the ids differ while the model does not.

| | Base URL | Key from env | Jev version |
|---|---|---|---|
| `backends.typesafe()` | `https://api.typesafe.ai` | `TYPESAFE_API_KEY` | `jev-1.13` |
| `backends.vercel()` | `https://ai-gateway.vercel.sh/typesafe` | `AI_GATEWAY_API_KEY` | `typesafe-ai/jev` |
| `backends.openrouter()` | `https://openrouter.ai/api` | `OPENROUTER_API_KEY` | `typesafe/jev-1.13` |

**Model-agnostic.** These take the model as a parameter, so they work with Von, Laya, or anything else speaking the protocol.

| | Base URL | Key | Model |
|---|---|---|---|
| `backends.custom({ baseUrl, model, … })` | yours | you supply, or omit for keyless | yours |
| `backends.gateway(url, { fetch })` | a deployed gateway | none | `"gateway"` |
| your own `Backend` | yours | yours | yours — see [Bring your own model](#bring-your-own-model) |

```ts
// A self-hosted open-weight model: same protocol, same wire format, no adapter.
backends.custom({ baseUrl: "http://localhost:8000", model: "von-1.0.0" });
```

Pinning a different Jev version is an override, not a fork:

```ts
backends.typesafe({ model: "jev-1.14" });
```

`backends.gateway()` targets a `DecisionGateway` you deployed — see [Deploy the gateway](#deploy-the-gateway). It sends no upstream credentials, because the gateway holds the key itself, and it reads no API key from your environment. That matters: SigV4 signing and a bearer token both write the same `authorization` header, so a stray key would overwrite your signature and every call would fail with a puzzling 403. `apiKey` is omitted from its options type and discarded at runtime so that cannot happen.

```ts
import aws4fetch from "aws4fetch";

const signedFetch = aws4fetch({ service: "lambda" });
const d = decide({ backend: backends.gateway(gatewayUrl, { fetch: signedFetch }) });
```

`fetch` is also the seam for retries, timeouts, and tests on any backend.

### Bring your own model

A model that doesn't speak `/v1/systemone` is not an adapter problem — it's a probabilities problem. Implement `Backend` and every layer above it (redaction, caching, gating, audit logging, the CDK construct) works unchanged:

```ts
import { decide, type Backend } from "lambda-decide";

const myBackend: Backend = {
  name: "my-model",
  model: "my-model-1.2",
  async evaluate({ state, questions }) {
    // must return { answers: { <questionName>: <raw answer> } }
    return { answers: await askYourModel(state, questions) };
  },
};

const d = decide({ backend: myBackend });
```

Two constraints decide how much work this actually is.

**You must return a probability per option.** `parseAnswer` reads `probabilities` — one per choice option, one per score level, one for noul — and derives `top`, `margin` and `certainty` from them. Missing keys are tolerated but default to `0`, which makes `margin` and `certainty` flat and sends every gate to `escalate`. So a backend that returns only a chosen label gets you a typed answer and useless confidence numbers. Extracting calibrated per-option probabilities from a model that wasn't built to emit them is the hard part, not the HTTP call: it's prompt engineering, or reading logits from a model you host.

**It is client-only.** The CDK construct serialises its backend into `DECIDE_CONFIG` as either `{ preset }` or `{ baseUrl, model }`, and the Lambda rebuilds it from that. A hand-written `Backend` object cannot cross that boundary, so a custom-model gateway is not deployable through `DecisionGateway` today. Use the client in-process, or put an adapter server in front of your model speaking `/v1/systemone` and deploy the gateway against *that*.

If your model does report a confidence number but on its own scale, `gate(name, { act, review, metric: "vendor" })` gates on `vendorConfidence` instead — falling back to `top` when the backend sends none.

### Confidence

Backends disagree about what `confidence` means, so every result carries three comparable numbers computed from the returned probabilities: `top` (probability of the winner), `margin` (winner minus runner-up) and `certainty` (1 minus normalised entropy). The backend's own value is kept as `vendorConfidence`. **Calibration holds on average, not per answer**: choose bands from your own labelled examples, and treat a noul near 0.5 as "don't know".

`gate(name, { act, review, metric? })` buckets an answer into `act` / `review` / `escalate` by comparing `act` and `review` against the chosen `metric` (`top` by default). Bands are validated before any paid call.

### Questions and limits

`choice` (2–255 options), `score` (2–10 criteria) and `noul`. Keys are returned verbatim. `none_of_the_above` options are not modelled. Per request: at most 32 questions, 64-char names, 4000-char text. `LIMITS` exports the numbers, and `parseQuestions` validates untrusted input into `invalid_request` errors.

### Errors

Every failure is a `DecideError` with a `code`: `invalid_request`, `auth`, `rate_limited`, `upstream`, `timeout`, `network`, `malformed_response`. `status` and `retryable` are set when the backend supplied them. 429, 502, 503, 504, 529 and network errors are retried twice by default with jittered backoff and `retry-after` honoured; auth failures never are.

## Deploy the gateway

```sh
cp .env.example .env
```

Pick a name for the key parameter. The convention here is `/lambda-decide/<backend>/api-key`, where `<backend>` is whatever you're talking to — it only has to be unique:

```sh
aws ssm put-parameter --name /lambda-decide/jev/api-key --type SecureString \
  --value "$(cat ~/.jev-api-key)" --overwrite --profile burner --region us-east-1
```

This is the only secret step, and the key never enters your code, `.env`, or the Lambda's configuration. `.env` holds the *pointer* to that parameter, not the key — it is gitignored:

```ini
DECIDE_API_KEY_SSM=/lambda-decide/jev/api-key   # where the key lives
DECIDE_BACKEND=typesafe                          # typesafe | openrouter | vercel
```

Point at any server that speaks `/v1/systemone` — a self-hosted Von or Laya, another gateway — by setting `DECIDE_BACKEND_URL` and `DECIDE_BACKEND_MODEL` instead of `DECIDE_BACKEND`. `DECIDE_BACKEND_MODEL` is the only model the gateway ever sends upstream, so it is where you pin a version:

```ini
DECIDE_BACKEND_URL=http://localhost:8000
DECIDE_BACKEND_MODEL=von-1.0.0
```

You can also pair a preset with an explicit version, which is how you upgrade Jev without editing code:

```ini
DECIDE_BACKEND=typesafe
DECIDE_BACKEND_MODEL=jev-1.14
```

Note that `DECIDE_BACKEND_URL` requires `DECIDE_BACKEND_MODEL`, since a URL alone doesn't say which model to ask for — the deploy fails rather than guessing.

Self-hosted Von and Laya usually need no key. Leave `DECIDE_API_KEY_SSM` unset and the gateway runs keyless, sending no `authorization` header upstream; the construct adds a synth warning so the omission is deliberate rather than accidental.

`.env` is deploy-time configuration only. Your gateway's own URL is deliberately absent from it: the Function URL is derived from the function that `.env` is building, so it cannot be an input to that same build. It is a stack **output** — see [Call the gateway](#call-the-gateway).

`handler.ts` reads it. There is no build step, so the CDK app is the TypeScript you wrote:

```ts
import { decideApp, DecisionGateway } from "lambda-decide/cdk";
import { loadDotEnv, backendFromEnv, apiKeySsmFromEnv } from "lambda-decide/cdk";

loadDotEnv();

decideApp("DecisionGateway", (stack) => {
  new DecisionGateway(stack, "Decisions", {
    backend: backendFromEnv(),
    ...(apiKeySsmFromEnv() ? { apiKeySsmParameter: apiKeySsmFromEnv() } : {}),
    redact: ["email", "card"],
    cache: { ttlSeconds: 300 },
  });
});
```

```sh
npx cdk bootstrap                                  # once per account/region
npx cdk deploy --app "npx tsx handler.ts" --profile burner
```

### Gateway options

| Option | Default | Notes |
|---|---|---|
| `backend` | `{ preset: "openrouter" }` | `{ preset, model? }` for a preset, or `{ baseUrl, path?, model }` for anything else. `model` overrides the preset's version, so you can upgrade Jev per-stack without editing the library. The default is `openrouter`, so set it explicitly when you mean something else. |
| `apiKeySsmParameter` | none | Name of an SSM `SecureString` **you** create, holding the upstream key. Omitting it warns at synth, and is correct for a keyless backend like self-hosted Von. The function is granted `ssm:GetParameter` on that one parameter only and reads it at runtime, so the key rotates without a redeploy. |
| `auth` | `"iam"` | Callers must SigV4-sign. `"none"` makes the URL public and warns at synth. |
| `redact` | none | `"email"`, `"phone"`, `"card"`, or any case-insensitive regex source. Applied to `state` before the upstream call. |
| `cache` | off | In-memory per execution environment, not shared across instances. Identical redacted requests skip the upstream call. |
| `reservedConcurrency` | none | A hard ceiling on spend. Needs spare account concurrency. |
| `maxBodyBytes` | 256 KiB | |
| `memorySize` / `timeout` / `logRetention` | 256 MB / 30 s / one month | The gateway holds no model. |

`grantInvoke(role)` lets another role call the URL. `memorySize` and `logRetention` are standard CDK props; `timeout` is a `Duration`.

### Wire format

Request: `{ state, questions, gate? }`, where `gate` is `{ [question]: { act, review, metric? } }`. Response: the upstream `{ answers, usage, model, id }` plus `gates` and `gateway: { cached, latency_ms }`. The model is fixed by deployment and a `model` in the request is ignored. Audit logs contain request id, question names and numbers, never the state or the instructions.

Error codes map to HTTP as `invalid_request` 400, `rate_limited` 429, `timeout` 504, and `auth` / `upstream` / `network` / `malformed_response` 502.

### Call the gateway

The URL is the stack's `GatewayUrl` output:

```sh
aws cloudformation describe-stacks --stack-name DecisionGateway --profile burner \
  --query "Stacks[0].Outputs[?OutputKey=='GatewayUrl'].OutputValue" --output text
```

The Function URL uses **IAM auth** by default, so sign requests with SigV4 — `curl --aws-sigv4 …`, or `aws4fetch` passed to `backends.gateway()`. In the CDK app you can read `gateway.url` directly.

## Notes and limits

- Wire format follows TypeSafe's `POST /v1/systemone`. Auth is sent as `Authorization: Bearer`; override with the `headers` option if your provider differs. A keyless backend gets no `authorization` header at all.
- Model ids are provider-specific and versioned: `api.typesafe.ai` takes `jev-1.13`, OpenRouter takes `typesafe/jev-1.13`, Vercel's gateway takes `typesafe-ai/jev`. The presets pin what each provider documents, so treat those ids as a starting point and override `model` when you upgrade. Nothing is hardcoded beyond that one table, and no preset's version is load-bearing for the protocol — `/v1/systemone` is the contract.
- Jev through OpenRouter rejects `/chat/completions` with `is a decisions model and cannot be used with the chat/completions endpoint`, naming `/api/alpha/decisions` instead. The preset already posts to `/v1/systemone`, which is the SystemOne-native route and is verified working — so a direct chat/completions call is the thing to avoid, not the preset.
- Probabilities from Jev vary slightly between identical calls, so gate on bands, not exact values. The cache also makes repeated identical requests stable. A different model will be calibrated differently, which is why bands belong to your own labelled examples.
- A backend that returns no `probabilities` still parses, but `margin` and `certainty` flatten to `0` and every gate fires. See [Bring your own model](#bring-your-own-model).
- The gateway's `timeoutMs` upstream deadline is not yet exposed as a construct prop, so a slow upstream can exhaust the 30 s Lambda timeout and surface as an opaque 502.
- Self-hosting an open model on Lambda is slow to cold-start and costs more per decision than hosted Jev. The gateway is still worth it in that case: it keeps the upstream off your network path and keeps the key and PII policy in one place.

## Develop

```sh
bun install
bun run typecheck   # tsc --noEmit
bun run test        # node:test, 42 tests, native TypeScript
bun run synth       # cdk synth for handler.ts
```

Node 22.18+, TypeScript 7, ESM only. **There is no build step.** The package ships TypeScript sources and `exports` points at them, so consume it with a TS-aware runtime (bun, `tsx`, or Node 24+). The Lambda asset is `src/` verbatim: `nodejs24.x` strips the types at cold start, `src/entry.mjs` is the committed one-line shim (Lambda's loader only resolves `.js`/`.mjs`/`.cjs`), and `src/package.json` is the nearest manifest marking those `.ts` files as ES modules. `cdk/` is excluded from the asset because it imports `aws-cdk-lib`, which the runtime does not ship. `@aws-sdk/client-ssm` comes from the runtime. No esbuild, no Docker, no `dist/`.

Apache-2.0.