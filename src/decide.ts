import type { Backend } from "./backends.ts";
import { gate, parseAnswer } from "./confidence.ts";
import { DecideError } from "./errors.ts";
import { parseQuestions } from "./questions.ts";
import type { Bands, Decision, Questions, Result, Results, State } from "./types.ts";

export interface DeciderOptions {
  readonly backend: Backend;
}

export interface AskOptions {
  readonly signal?: AbortSignal;
}

export interface Decider {
  /**
   * Ask one or more typed questions about `state` in a single round trip.
   * Answers are typed from the questions you pass in.
   */
  ask<Qs extends Questions>(state: State, questions: Qs, options?: AskOptions): Promise<Decision<Qs>>;
}

export function decide({ backend }: DeciderOptions): Decider {
  return {
    async ask<Qs extends Questions>(state: State, questions: Qs, options: AskOptions = {}): Promise<Decision<Qs>> {
      parseQuestions(questions);
      const raw = await backend.evaluate({ state, questions, ...(options.signal ? { signal: options.signal } : {}) });

      const answers: Record<string, Result> = {};
      for (const [name, question] of Object.entries(questions)) {
        if (!(name in raw.answers)) {
          throw new DecideError("malformed_response", `${backend.name}: no answer returned for "${name}"`);
        }
        answers[name] = parseAnswer(name, question, raw.answers[name]);
      }

      return {
        answers: answers as Results<Qs>,
        ...(raw.model ? { model: raw.model } : {}),
        ...(raw.id ? { id: raw.id } : {}),
        ...(raw.usage ? { usage: raw.usage } : {}),
        gate(name: keyof Qs & string, bands: Bands) {
          const result = answers[name];
          if (!result) throw new DecideError("invalid_request", `no answer named "${name}"`);
          return gate(result, bands);
        },
      };
    },
  };
}
