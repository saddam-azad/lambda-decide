import { DecideError } from "./errors.ts";
import type { ChoiceQuestion, NoulQuestion, Question, Questions, ScoreQuestion } from "./types.ts";

export const LIMITS = {
  minOptions: 2,
  maxChoices: 255,
  maxScoreLevels: 10,
  maxQuestions: 32,
  maxNameLength: 64,
  maxTextLength: 4_000,
} as const;

const invalid = (message: string): never => {
  throw new DecideError("invalid_request", message);
};

/** Pick exactly one option. Option keys are returned verbatim, and typed as a union. */
export function choice<K extends string>(
  instructions: string,
  criteria: { readonly [P in K]: string },
): ChoiceQuestion<K> {
  const q: ChoiceQuestion<K> = { type: "choice", instructions, criteria };
  validateQuestion("choice", q);
  return q;
}

/** Place the state on an ordered scale. List levels from least to most. */
export function score(instructions: string, criteria: readonly string[]): ScoreQuestion {
  const q: ScoreQuestion = { type: "score", instructions, criteria };
  validateQuestion("score", q);
  return q;
}

/** Probability that a yes/no proposition holds. */
export function noul(instructions: string): NoulQuestion {
  const q: NoulQuestion = { type: "noul", instructions };
  validateQuestion("noul", q);
  return q;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isText = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= LIMITS.maxTextLength;

function validateQuestion(name: string, q: unknown): asserts q is Question {
  if (!isRecord(q)) return invalid(`question "${name}" must be an object`);
  if (!isText(q["instructions"])) {
    return invalid(`question "${name}": instructions must be a non-empty string (max ${LIMITS.maxTextLength} chars)`);
  }
  switch (q["type"]) {
    case "noul":
      return;
    case "choice": {
      const c = q["criteria"];
      if (!isRecord(c)) return invalid(`question "${name}": choice criteria must be an object of option -> description`);
      const n = Object.keys(c).length;
      if (n < LIMITS.minOptions || n > LIMITS.maxChoices) {
        return invalid(`question "${name}": choice needs ${LIMITS.minOptions}-${LIMITS.maxChoices} options, got ${n}`);
      }
      if (!Object.values(c).every(isText)) return invalid(`question "${name}": every option needs a description`);
      return;
    }
    case "score": {
      const c = q["criteria"];
      if (!Array.isArray(c)) return invalid(`question "${name}": score criteria must be an ordered array`);
      if (c.length < LIMITS.minOptions || c.length > LIMITS.maxScoreLevels) {
        return invalid(`question "${name}": score needs ${LIMITS.minOptions}-${LIMITS.maxScoreLevels} levels, got ${c.length}`);
      }
      if (!c.every(isText)) return invalid(`question "${name}": every level needs a description`);
      return;
    }
    default:
      return invalid(`question "${name}": type must be "choice", "score" or "noul"`);
  }
}

/** Validate untrusted input (e.g. a request body) into typed questions. Throws DecideError("invalid_request"). */
export function parseQuestions(input: unknown): Questions {
  if (!isRecord(input)) return invalid("questions must be an object of name -> question");
  const entries = Object.entries(input);
  if (entries.length === 0) return invalid("at least one question is required");
  if (entries.length > LIMITS.maxQuestions) return invalid(`at most ${LIMITS.maxQuestions} questions per request`);
  for (const [name, q] of entries) {
    if (name.length === 0 || name.length > LIMITS.maxNameLength) {
      return invalid(`question names must be 1-${LIMITS.maxNameLength} characters`);
    }
    validateQuestion(name, q);
  }
  return input as Questions;
}
