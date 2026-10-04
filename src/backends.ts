import { setTimeout as sleep } from "node:timers/promises";
import { DecideError } from "./errors.ts";
import type { Questions, State, Usage } from "./types.ts";

export interface BackendRequest {
  readonly state: State;
  readonly questions: Questions;
  readonly signal?: AbortSignal;
}

export interface BackendResponse {
  /** Raw per-question answers exactly as the backend returned them. */
  readonly answers: { readonly [name: string]: unknown };
  readonly model?: string;
  readonly id?: string;
  readonly usage?: Usage;
}

export interface Backend {
  readonly name: string;
  /** The model id sent upstream (informational; used for cache keys). */
  readonly model: string;
  evaluate(request: BackendRequest): Promise<BackendResponse>;
}

export interface SystemOneOptions {
  readonly name?: string;
  /** e.g. https://api.typesafe.ai (no trailing slash needed; may include a path prefix). */
  readonly baseUrl: string;
  /** Default "/v1/systemone". */
  readonly path?: string;
  readonly model: string;
  /** Bearer token. A function is called per request (handy for rotated secrets). Omit for keyless local servers. */
  readonly apiKey?: string | (() => string | Promise<string>);
  readonly headers?: { readonly [name: string]: string };
  /** Per attempt. Default 15s. */
  readonly timeoutMs?: number;
  /** Extra attempts on 429/502/503/504/529 and network errors. Default 2. */
  readonly retries?: number;
  /** Inject for tests, or a SigV4-signing fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

const RETRYABLE = new Set([429, 502, 503, 504, 529]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function parseUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined;
  const cost = num(raw["cost"]);
  return {
    inputTokens: num(raw["input_tokens"]) ?? 0,
    outputTokens: num(raw["output_tokens"]) ?? 0,
    ...(cost === undefined ? {} : { cost }),
  };
}

function retryAfterMs(res: Response): number | undefined {
  const seconds = Number(res.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 10) * 1000 : undefined;
}

/** Speaks TypeSafe's `POST /v1/systemone` protocol. Works for every server/gateway that implements it. */
export function systemOne(options: SystemOneOptions): Backend {
  const {
    name = "systemone", baseUrl, path = "/v1/systemone", model, apiKey,
    headers = {}, timeoutMs = 15_000, retries = 2, fetch: fetchImpl = globalThis.fetch,
  } = options;
  const url = baseUrl.replace(/\/+$/, "") + path;

  return {
    name,
    model,
    async evaluate({ state, questions, signal }) {
      const key = typeof apiKey === "function" ? await apiKey() : apiKey;
      const body = JSON.stringify({ model, state, questions });
      const requestHeaders = {
        "content-type": "application/json",
        accept: "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...headers,
      };

      for (let attempt = 0; ; attempt++) {
        const attemptSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
        let res: Response;
        try {
          res = await fetchImpl(url, { method: "POST", headers: requestHeaders, body, signal: attemptSignal });
        } catch (cause) {
          if (signal?.aborted) throw signal.reason ?? cause; // the caller cancelled: not our error
          const timedOut = cause instanceof Error && cause.name === "TimeoutError";
          if (attempt < retries) { await sleep(backoff(attempt), undefined, signal ? { signal } : undefined); continue; }
          throw new DecideError(timedOut ? "timeout" : "network", `${name}: ${timedOut ? `timed out after ${timeoutMs}ms` : "network error"}`, { cause, retryable: true });
        }

        if (res.ok) return parseResponse(name, await res.json().catch((cause: unknown) => {
          throw new DecideError("malformed_response", `${name}: response was not JSON`, { cause });
        }));

        const detail = (await res.text().catch(() => "")).slice(0, 300);
        if (RETRYABLE.has(res.status) && attempt < retries) {
          await sleep(retryAfterMs(res) ?? backoff(attempt), undefined, signal ? { signal } : undefined);
          continue;
        }
        const code = res.status === 401 || res.status === 403 ? "auth" : res.status === 429 ? "rate_limited" : res.status === 400 || res.status === 422 ? "invalid_request" : "upstream";
        throw new DecideError(code, `${name}: HTTP ${res.status}${detail ? ` ${detail}` : ""}`, { status: res.status, retryable: RETRYABLE.has(res.status) });
      }
    },
  };
}

const backoff = (attempt: number): number => Math.min(2_000, 200 * 2 ** attempt) * (0.5 + Math.random() / 2);

function parseResponse(name: string, json: unknown): BackendResponse {
  if (!isRecord(json) || !isRecord(json["answers"])) {
    throw new DecideError("malformed_response", `${name}: response has no "answers" object`);
  }
  const usage = parseUsage(json["usage"]);
  return {
    answers: json["answers"],
    ...(typeof json["model"] === "string" ? { model: json["model"] } : {}),
    ...(typeof json["id"] === "string" ? { id: json["id"] } : {}),
    ...(usage ? { usage } : {}),
  };
}

/* ---------------------------------------------------------------- presets */

export type PresetName = "typesafe" | "openrouter" | "vercel";

interface Preset { readonly baseUrl: string; readonly model: string; readonly keyEnv: string }

/** Base URLs and model ids as documented by each provider (Oct 2026). Override any of them. */
export const PRESETS: { readonly [P in PresetName]: Preset } = {
  typesafe: { baseUrl: "https://api.typesafe.ai", model: "jev-1.13", keyEnv: "TYPESAFE_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api", model: "typesafe/jev-1.13", keyEnv: "OPENROUTER_API_KEY" },
  vercel: { baseUrl: "https://ai-gateway.vercel.sh/typesafe", model: "typesafe-ai/jev", keyEnv: "AI_GATEWAY_API_KEY" },
};

export type PresetOptions = Partial<Omit<SystemOneOptions, "baseUrl">> & { readonly baseUrl?: string };

function preset(name: PresetName, overrides: PresetOptions): Backend {
  const p = PRESETS[name];
  const envKey = process.env[p.keyEnv];
  return systemOne({
    name, baseUrl: p.baseUrl, model: p.model,
    ...(envKey ? { apiKey: envKey } : {}),
    ...overrides,
  });
}

/**
 * Options for `backends.gateway`. `baseUrl`, `path` and `model` are fixed, and `apiKey` is
 * excluded on purpose: the gateway already holds the upstream key, and any `authorization`
 * header you set would overwrite the SigV4 signature your `fetch` puts in that same header.
 * Leaving it off also means no `OPENROUTER_API_KEY` in the ambient environment can clobber it.
 */
export type GatewayOptions = Omit<SystemOneOptions, "baseUrl" | "path" | "model" | "apiKey">;

/** The model label sent to a deployed gateway, which fixes the real model itself and ignores this. */
export const GATEWAY_MODEL = "gateway";

export const backends = {
  /** TypeSafe's own API. Reads TYPESAFE_API_KEY. */
  typesafe: (o: PresetOptions = {}): Backend => preset("typesafe", o),
  /** Jev through OpenRouter. Reads OPENROUTER_API_KEY. */
  openrouter: (o: PresetOptions = {}): Backend => preset("openrouter", o),
  /** Jev through Vercel AI Gateway. Reads AI_GATEWAY_API_KEY. */
  vercel: (o: PresetOptions = {}): Backend => preset("vercel", o),
  /** Any server speaking /v1/systemone: a self-hosted Von/Laya, another gateway, or a deployed DecisionGateway. */
  custom: systemOne,
  /**
   * A DecisionGateway you deployed, addressed by the bare URL from its "GatewayUrl" stack
   * output. Sends no upstream credentials, and signs with SigV4 if you pass `fetch`.
   */
  gateway: (baseUrl: string, o: GatewayOptions = {}): Backend => {
    // Strip apiKey even from untyped callers: honouring it would overwrite the SigV4
    // signature that fetch puts in the very same authorization header.
    const { apiKey: _ignored, ...rest } = o as SystemOneOptions;
    return systemOne({ name: "gateway", ...rest, baseUrl, model: GATEWAY_MODEL });
  },
} as const;

/** JSON-serialisable backend description (used by the CDK construct and the Lambda handler). */
export type BackendConfig =
  | { readonly preset: PresetName; readonly model?: string }
  | { readonly baseUrl: string; readonly path?: string; readonly model: string };

export function createBackend(
  config: BackendConfig,
  extra: Pick<SystemOneOptions, "apiKey" | "timeoutMs" | "retries" | "fetch"> = {},
): Backend {
  if ("preset" in config) {
    return preset(config.preset, { ...extra, ...(config.model ? { model: config.model } : {}) });
  }
  return systemOne({ ...extra, baseUrl: config.baseUrl, model: config.model, ...(config.path ? { path: config.path } : {}) });
}
