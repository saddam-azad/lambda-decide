import assert from "node:assert/strict";
import { test } from "node:test";
import { choice, noul, score, parseAnswer, gate, metricsOf, DecideError } from "../src/index.ts";
import { JEV_MUDDY_TICKET } from "./helpers.ts";

const team = choice("Which team?", { account: "login", technical: "bugs", billing: "charges" });
const severity = score("How severe?", ["cosmetic", "workaround exists", "blocking"]);

test("choice: keeps vendor confidence, computes comparable metrics", () => {
  const r = parseAnswer("team", team, JEV_MUDDY_TICKET.answers.team);
  assert.ok(r.type === "choice");
  assert.equal(r.choice, "billing");
  assert.equal(r.vendorConfidence, 0.69);
  assert.ok(Math.abs(r.top - 0.79) < 1e-9);
  assert.ok(Math.abs(r.margin - 0.6) < 1e-9);
  assert.ok(r.certainty > 0.3 && r.certainty < 0.7);
});

test("score: expected value and argmax level", () => {
  const r = parseAnswer("severity", severity, JEV_MUDDY_TICKET.answers.severity);
  assert.ok(r.type === "score");
  assert.equal(r.score, 1.15);
  assert.equal(r.level, 1);
  assert.deepEqual(r.legend, { 0: "cosmetic", 1: "workaround exists", 2: "blocking" });
});

test("score: computes the expected value when a backend omits it", () => {
  const r = parseAnswer("severity", severity, { probabilities: { "1": 0.5, "2": 0.5 } });
  assert.ok(r.type === "score");
  assert.equal(r.score, 1.5);
});

test("noul near 0.5 is 'don't know' and escalates; extremes act", () => {
  const unsure = parseAnswer("refund", noul("Money back?"), JEV_MUDDY_TICKET.answers.refund);
  assert.ok(unsure.type === "noul");
  assert.equal(unsure.verdict, false);
  assert.equal(gate(unsure, { act: 0.9, review: 0.7 }), "escalate");
  const sure = parseAnswer("refund", noul("Money back?"), { noul: 0.99 });
  assert.equal(gate(sure, { act: 0.9, review: 0.7 }), "act");
});

test("gate bands and metrics", () => {
  const r = parseAnswer("team", team, JEV_MUDDY_TICKET.answers.team);
  assert.equal(gate(r, { act: 0.9, review: 0.6 }), "review"); // top .79
  assert.equal(gate(r, { act: 0.75, review: 0.5 }), "act");
  assert.equal(gate(r, { act: 0.9, review: 0.5, metric: "margin" }), "review"); // margin .6
  assert.equal(gate(r, { act: 0.7, review: 0.5, metric: "vendor" }), "review"); // vendor .69
  assert.throws(() => gate(r, { act: 0.5, review: 0.9 }), DecideError);
});

test("metricsOf handles rounded and degenerate vectors", () => {
  assert.deepEqual(metricsOf([1, 0, 0]), { top: 1, margin: 1, certainty: 1 });
  const uniform = metricsOf([0.25, 0.25, 0.25, 0.25]);
  assert.equal(uniform.margin, 0);
  assert.ok(uniform.certainty < 1e-9);
  assert.ok(Math.abs(metricsOf([0.49, 0.49]).top - 0.5) < 1e-9); // renormalised
});

test("malformed answers throw malformed_response", () => {
  for (const [q, raw] of [
    [team, { choice: "sales", probabilities: {} }],
    [team, { choice: "billing" }],
    [team, "billing"],
    [noul("x"), { noul: 1.5 }],
    [severity, { probabilities: { "0": "high" } }],
  ] as const) {
    assert.throws(() => parseAnswer("q", q, raw), (e: unknown) => e instanceof DecideError && e.code === "malformed_response");
  }
});
