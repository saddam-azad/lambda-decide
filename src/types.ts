/** Anything JSON-serialisable you want a decision about. */
export type State = string | readonly unknown[] | { readonly [key: string]: unknown };

export interface ChoiceQuestion<K extends string = string> {
  readonly type: "choice";
  readonly instructions: string;
  /** option key -> description. The key is returned as the answer. */
  readonly criteria: { readonly [P in K]: string };
}

export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: string;
  /** Ordered levels, least to most. */
  readonly criteria: readonly string[];
}

export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type Questions = { readonly [name: string]: Question };

/**
 * Metrics computed locally from the returned probabilities, so every backend
 * (Jev, Von, Laya, ...) is comparable even though their own `confidence`
 * fields mean different things.
 */
export interface Metrics {
  /** Probability of the winning answer (noul: max(p, 1 - p)). */
  readonly top: number;
  /** top minus runner-up (noul: |2p - 1|). */
  readonly margin: number;
  /** 1 - normalised entropy: 0 = uniform, 1 = fully concentrated. */
  readonly certainty: number;
  /** The backend's own `confidence`, untouched, when it sent one. */
  readonly vendorConfidence?: number;
}

export interface ChoiceResult<K extends string = string> extends Metrics {
  readonly type: "choice";
  readonly choice: K;
  readonly probabilities: { readonly [P in K]: number };
}

export interface ScoreResult extends Metrics {
  readonly type: "score";
  /** Probability-weighted level, 0 .. levels-1. */
  readonly score: number;
  /** Most likely level (argmax). */
  readonly level: number;
  readonly legend: { readonly [level: string]: string };
  readonly probabilities: { readonly [level: string]: number };
}

export interface NoulResult extends Metrics {
  readonly type: "noul";
  /** P(yes). */
  readonly probability: number;
  /** probability >= 0.5. Near 0.5 means "don't know": gate it. */
  readonly verdict: boolean;
}

export type Result = ChoiceResult | ScoreResult | NoulResult;

export type ResultOf<Q> =
  Q extends ChoiceQuestion<infer K> ? ChoiceResult<K>
  : Q extends ScoreQuestion ? ScoreResult
  : Q extends NoulQuestion ? NoulResult
  : never;

export type Results<Qs extends Questions> = { readonly [N in keyof Qs]: ResultOf<Qs[N]> };

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost?: number;
}

export type Band = "act" | "review" | "escalate";

export interface Bands {
  /** metric >= act  -> "act" (run automatically). */
  readonly act: number;
  /** metric >= review -> "review" (confirm / second opinion); below -> "escalate". */
  readonly review: number;
  /** Which number to compare. Default "top". "vendor" falls back to "top" if the backend sent none. */
  readonly metric?: "top" | "margin" | "certainty" | "vendor";
}

export interface Decision<Qs extends Questions> {
  readonly answers: Results<Qs>;
  readonly model?: string;
  readonly id?: string;
  readonly usage?: Usage;
  /** Bucket one answer into act / review / escalate. */
  gate<N extends keyof Qs & string>(name: N, bands: Bands): Band;
}
