export type { ChoiceResult } from "../src/index.ts";
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** A fetch that replays canned responses and records requests. */
export function fakeFetch(...responses: readonly (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const queue = [...responses];
  const fn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = queue.shift() ?? responses.at(-1)!;
    if (next instanceof Error) throw next;
    return next.clone();
  };
  return { fetch: fn, calls };
}

export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Real response values from OpenRouter's "What is Jev?" article (21 Sep 2026). */
export const JEV_MUDDY_TICKET = {
  model: "typesafe/jev-1.13-20260917",
  id: "gen-dec-1",
  answers: {
    team: { type: "choice", choice: "billing", probabilities: { account: 0.02, technical: 0.19, billing: 0.79 }, confidence: 0.69 },
    severity: { type: "score", score: 1.15, probabilities: { "0": 0, "1": 0.85, "2": 0.15 }, confidence: 0.77 },
    refund: { type: "noul", noul: 0.49 },
  },
  usage: { input_tokens: 447, output_tokens: 69, cost: 0.000018774 },
};
