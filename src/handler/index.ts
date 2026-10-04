import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { createBackend, type Backend, type BackendConfig, type BackendResponse } from "../backends.ts";
import { gate, parseAnswer, validateBands } from "../confidence.ts";
import { DecideError } from "../errors.ts";
import { parseQuestions } from "../questions.ts";
import type { Band, Bands, State } from "../types.ts";
import { cacheKey, TtlCache } from "./cache.ts";
import { compileRedactions, redact } from "./redact.ts";

export interface GatewayConfig {
  readonly backend: BackendConfig;
  /** Name/path of an SSM SecureString parameter holding the upstream API key. */
  readonly apiKeySsm?: string;
  readonly cache?: { readonly ttlSeconds: number; readonly maxEntries: number };
  readonly redact?: readonly string[];
  /** Default 256 KiB. */
  readonly maxBodyBytes?: number;
  readonly timeoutMs?: number;
}

export interface HandlerDeps {
  readonly config: GatewayConfig;
  /** Override for tests. */
  readonly backend?: Backend;
  /** Override for tests: stand in for `SSMClient.send(GetParameterCommand)`. */
  readonly ssmSend?: SsmSend;
  /** Override for tests: the fetch used to reach the upstream backend. */
  readonly fetch?: typeof globalThis.fetch;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
}

/** The slice of `SSMClient.send(GetParameterCommand)` the gateway actually uses. */
export type SsmSend = (input: { readonly Name: string; readonly WithDecryption?: boolean }) =>
Promise<{ readonly Parameter?: { readonly Value?: string | undefined } | undefined }>;

type Handler = (event: APIGatewayProxyEventV2, context?: { readonly awsRequestId?: string }) => Promise<APIGatewayProxyStructuredResultV2>;

const KEY_REFRESH_MS = 5 * 60_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The SDK exception's class name, e.g. "ParameterNotFoundException" or "AccessDeniedException". */
const sdkError = (cause: unknown): string =>
  cause instanceof Error ? cause.name : typeof cause === "string" ? cause : "unknown error";

/**
 * Reads the upstream API key from an SSM SecureString, cached per execution environment for
 * 5 minutes. Every failure here means "the key is not usable", so all of them map to `auth`:
 * a missing parameter, a denied grant, a failed decrypt. GetParameter *throws* rather than
 * returning empty, which is why the call itself is guarded and not just the value.
 */
function apiKeyReader(parameterName: string, now: () => number, send?: SsmSend): () => Promise<string> {
  let cached: { readonly value: string; readonly at: number } | undefined;
  return async () => {
    if (cached && now() - cached.at < KEY_REFRESH_MS) return cached.value;

    let value: string | undefined;
    try {
      const ssmSend: SsmSend = send ?? (async ({ Name, WithDecryption }) => {
        const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
        const out = await new SSMClient({}).send(new GetParameterCommand({ Name, WithDecryption }));
        return out.Parameter ? { Parameter: { Value: out.Parameter.Value } } : {};
      });
      value = (await ssmSend({ Name: parameterName, WithDecryption: true })).Parameter?.Value?.trim();
    } catch (cause) {
      throw new DecideError(
        "auth",
        `could not read the upstream API key from SSM parameter ${parameterName} (${sdkError(cause)}). ` +
          `Check it exists, is a SecureString, and that the function's role may ssm:GetParameter on it.`,
        { cause },
      );
    }
    if (!value || value === "REPLACE_ME") {
      throw new DecideError(
        "auth",
        `upstream API key missing or still a placeholder: set it with ` +
        `"aws ssm put-parameter --name ${parameterName} --type SecureString --value ... --overwrite"`,
      );
    }
    cached = { value, at: now() };
    return value;
  };
}

function parseGates(input: unknown, names: ReadonlySet<string>): Record<string, Bands> {
  if (input === undefined) return {};
  if (!isRecord(input)) throw new DecideError("invalid_request", `"gate" must be an object of question name -> bands`);
  const out: Record<string, Bands> = {};
  for (const [name, b] of Object.entries(input)) {
    if (!names.has(name)) throw new DecideError("invalid_request", `gate refers to unknown question "${name}"`);
    if (!isRecord(b) || typeof b["act"] !== "number" || typeof b["review"] !== "number") {
      throw new DecideError("invalid_request", `gate "${name}" needs numeric act and review`);
    }
    const metric = b["metric"];
    if (metric !== undefined && metric !== "top" && metric !== "margin" && metric !== "certainty" && metric !== "vendor") {
      throw new DecideError("invalid_request", `gate "${name}": unknown metric`);
    }
    const bands: Bands = { act: b["act"], review: b["review"], ...(metric ? { metric } : {}) };
    validateBands(bands); // reject before any upstream call is made (and paid for)
    out[name] = bands;
  }
  return out;
}

const json = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

const STATUS = { invalid_request: 400, auth: 502, rate_limited: 429, upstream: 502, timeout: 504, network: 502, malformed_response: 502 } as const;

export function createHandler(deps: HandlerDeps): Handler {
  const { config, log = console.log, now = Date.now } = deps;
  const rules = compileRedactions(config.redact ?? []);
  const cache = config.cache ? new TtlCache<BackendResponse>(config.cache.ttlSeconds, config.cache.maxEntries, now) : undefined;
  const maxBytes = config.maxBodyBytes ?? 256 * 1024;
  const apiKey = config.apiKeySsm ? apiKeyReader(config.apiKeySsm, now, deps.ssmSend) : undefined;
  const backend = deps.backend ?? createBackend(config.backend, {
    ...(apiKey ? { apiKey } : process.env["DECIDE_API_KEY"] ? { apiKey: process.env["DECIDE_API_KEY"] } : {}),
    ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  return async (event, context) => {
    const started = now();
    const requestId = context?.awsRequestId ?? event.requestContext?.requestId ?? "unknown";
    try {
      if (event.requestContext?.http?.method !== "POST") {
        return { ...json(405, { error: { type: "invalid_request", message: "POST only" } }), headers: { allow: "POST", "content-type": "application/json" } };
      }
      const text = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
      if (Buffer.byteLength(text) > maxBytes) throw new DecideError("invalid_request", `body exceeds ${maxBytes} bytes`);

      let body: unknown;
      try { body = JSON.parse(text); } catch (cause) { throw new DecideError("invalid_request", "body is not valid JSON", { cause }); }
      if (!isRecord(body)) throw new DecideError("invalid_request", "body must be a JSON object");
      if (body["state"] === undefined || body["state"] === null || body["state"] === "") {
        throw new DecideError("invalid_request", "state is required");
      }

      const questions = parseQuestions(body["questions"]);
      const gates = parseGates(body["gate"], new Set(Object.keys(questions)));
      const state = redact(body["state"] as State, rules);

      // The model is fixed by deployment config; a client-supplied "model" is ignored on purpose.
      const key = cacheKey(backend.model, state, questions);
      const hit = cache?.get(key);
      const upstream = hit ?? await backend.evaluate({ state, questions });
      if (!hit) cache?.set(key, upstream);

      // Parse every answer: this both validates the upstream shape and gives us metrics to log and gate on.
      const parsed = Object.entries(questions).map(([name, q]) => [name, parseAnswer(name, q, upstream.answers[name])] as const);
      const bands: Record<string, Band> = {};
      for (const [name, result] of parsed) {
        const g = gates[name];
        if (g) bands[name] = gate(result, g);
      }

      const latencyMs = now() - started;
      // Audit line: ids, question names, numbers. Never the state, never the instructions.
      log(JSON.stringify({
        msg: "decision", requestId, backend: backend.name, model: upstream.model ?? backend.model, cached: hit !== undefined, latencyMs,
        inputTokens: upstream.usage?.inputTokens,
        questions: Object.fromEntries(parsed.map(([name, r]) => [name, {
          type: r.type, top: round(r.top), margin: round(r.margin), ...(bands[name] ? { band: bands[name] } : {}),
        }])),
      }));

      return json(200, {
        ...(upstream.id ? { id: upstream.id } : {}),
        ...(upstream.model ? { model: upstream.model } : {}),
        answers: upstream.answers,
        ...(upstream.usage ? { usage: { input_tokens: upstream.usage.inputTokens, output_tokens: upstream.usage.outputTokens, ...(upstream.usage.cost === undefined ? {} : { cost: upstream.usage.cost }) } } : {}),
        ...(Object.keys(bands).length ? { gates: bands } : {}),
        gateway: { cached: hit !== undefined, latency_ms: latencyMs },
      });
    } catch (error) {
      const unexpected = !(error instanceof DecideError);
      const e = error instanceof DecideError ? error : new DecideError("upstream", "internal error", { cause: error });
      // The cause goes to our logs only; the caller still gets a generic message.
      const inner = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      const cause = inner instanceof Error ? { cause: `${sdkError(inner)}: ${inner.message}` } : {};
      log(JSON.stringify({ msg: "error", requestId, code: e.code, status: e.status, message: e.message, ...cause, latencyMs: now() - started }));
      const status = unexpected ? 500 : STATUS[e.code];
      // Don't leak upstream response bodies to callers.
      const message = e.code === "invalid_request" ? e.message : e.code === "auth" ? "gateway upstream authentication failed" : e.code === "rate_limited" ? "upstream rate limited" : "upstream error";
      return json(status, { error: { type: e.code, message } });
    }
  };
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** Lambda entrypoint. Configuration arrives as JSON in DECIDE_CONFIG (set by the CDK construct). */
let instance: Handler | undefined;
export const handler: Handler = (event, context) => {
  if (!instance) {
    const raw = process.env["DECIDE_CONFIG"];
    if (!raw) throw new Error("DECIDE_CONFIG is not set; deploy this handler with the DecisionGateway construct");
    instance = createHandler({ config: JSON.parse(raw) as GatewayConfig });
  }
  return instance(event, context);
};
