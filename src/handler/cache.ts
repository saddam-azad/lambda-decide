import { createHash } from "node:crypto";

/** Per-execution-environment LRU with TTL. Not shared between Lambda instances. */
export class TtlCache<V> {
  readonly #entries = new Map<string, { readonly value: V; readonly expires: number }>();
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;

  constructor(ttlSeconds: number, maxEntries: number, now: () => number = Date.now) {
    this.#ttlMs = ttlSeconds * 1000;
    this.#max = maxEntries;
    this.#now = now;
  }

  get(key: string): V | undefined {
    const hit = this.#entries.get(key);
    if (!hit) return undefined;
    this.#entries.delete(key);
    if (hit.expires <= this.#now()) return undefined;
    this.#entries.set(key, hit); // refresh recency
    return hit.value;
  }

  set(key: string, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expires: this.#now() + this.#ttlMs });
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const cacheKey = (...parts: readonly unknown[]): string =>
  createHash("sha256").update(canonical(parts)).digest("hex");
