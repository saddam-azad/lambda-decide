import assert from "node:assert/strict";
import { test } from "node:test";
import { choice, noul, parseQuestions, score, DecideError } from "../src/index.ts";
import type { ChoiceResult, Equal } from "./helpers.ts";

test("choice keys become a literal union", () => {
  const q = choice("Which team?", { billing: "charges", technical: "bugs" });
  const _check: Equal<keyof typeof q.criteria, "billing" | "technical"> = true;
  assert.equal(_check, true);
  const _result: ChoiceResult<"billing" | "technical">["choice"] = "billing";
  // @ts-expect-error not a declared option
  const _bad: ChoiceResult<"billing" | "technical">["choice"] = "sales";
  void _result; void _bad;
});

test("builders enforce documented limits", () => {
  assert.throws(() => choice("x", { only: "one" }), DecideError);
  assert.throws(() => score("x", ["a"]), DecideError);
  assert.throws(() => score("x", Array.from({ length: 11 }, (_, i) => `level ${i}`)), /2-10 levels/);
  assert.throws(() => noul("   "), DecideError);
  assert.doesNotThrow(() => score("x", ["low", "high"]));
});

test("parseQuestions rejects untrusted garbage with invalid_request", () => {
  for (const bad of [null, [], {}, { q: 1 }, { q: { type: "choice", instructions: "x", criteria: ["a", "b"] } }, { q: { type: "nope", instructions: "x" } }]) {
    assert.throws(() => parseQuestions(bad), (e: unknown) => e instanceof DecideError && e.code === "invalid_request");
  }
  assert.doesNotThrow(() => parseQuestions({ q: noul("Is it urgent?") }));
});
