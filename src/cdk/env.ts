import { readFileSync } from "node:fs";
import type { BackendConfig, PresetName } from "../backends.ts";

/**
 * Minimal .env reader: `KEY=VALUE` lines, `#` comments, optional single/double quotes.
 * The real environment always wins, so an exported variable overrides the file.
 * Deliberately not `process.loadEnvFile`: it exists in Node but not in bun, and this
 * module has to run under both. Never overrides an already-set variable.
 */
export function loadDotEnv(path = ".env", env: NodeJS.ProcessEnv = process.env): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // no .env is fine: everything can come from the real environment
  }
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2]!.replace(/^(["'])(.*)\1$/, "$2");
    if (env[match[1]!] === undefined) env[match[1]!] = value;
  }
}

const PRESET_NAMES: readonly PresetName[] = ["typesafe", "openrouter", "vercel"];

/**
 * Which decision backend to deploy against, from the environment:
 *
 *   DECIDE_BACKEND=typesafe                              a preset, default openrouter
 *   DECIDE_BACKEND_URL=https://… + DECIDE_BACKEND_MODEL=von-1.0.0   any /v1/systemone server
 *
 * Deliberately not DECIDE_MODEL: that names the *gateway* for callers and never reaches an
 * upstream, so sharing the name would silently ask Jev for a model called "gateway".
 */
export function backendFromEnv(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const url = env["DECIDE_BACKEND_URL"];
  const model = env["DECIDE_BACKEND_MODEL"];
  if (url) {
    if (!model) {
      throw new Error("lambda-decide: DECIDE_BACKEND_MODEL is required alongside DECIDE_BACKEND_URL (it names the model to ask for)");
    }
    return { baseUrl: url, model };
  }
  const preset = (env["DECIDE_BACKEND"] ?? "openrouter") as PresetName;
  if (!PRESET_NAMES.includes(preset)) {
    throw new Error(
      `lambda-decide: DECIDE_BACKEND must be one of ${PRESET_NAMES.join(", ")} — or set DECIDE_BACKEND_URL and DECIDE_BACKEND_MODEL`,
    );
  }
  return model ? { preset, model } : { preset };
}

/** SSM SecureString parameter holding the upstream API key. A pointer, never the key itself. */
export function apiKeySsmFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env["DECIDE_API_KEY_SSM"] || undefined;
}
