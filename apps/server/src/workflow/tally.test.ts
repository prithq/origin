import { test } from "node:test";
import assert from "node:assert/strict";
import type { JurorVerdict } from "@origin/contracts";
import { tallyVotes } from "./tally.js";

function verdict(juror: JurorVerdict["juror"], vote: "yes" | "no"): JurorVerdict {
  return {
    juror,
    vote,
    score: vote === "yes" ? 70 : 30,
    summary: `${juror} says ${vote}`,
    reasoning: "reasoning",
    supportingEvidenceIds: [],
    concerns: [],
    conditionsForApproval: [],
  };
}

const twoYes = [
  verdict("investor", "yes"),
  verdict("technical-architect", "yes"),
  verdict("customer-advocate", "no"),
];

const oneYes = [
  verdict("investor", "yes"),
  verdict("technical-architect", "no"),
  verdict("customer-advocate", "no"),
];

test("approves only when 2+ jurors and the human say yes", () => {
  const tally = tallyVotes(twoYes, "yes");
  assert.equal(tally.approved, true);
  assert.equal(tally.aiYes, 2);
});

test("rejects when the jury clears but the human says no", () => {
  const tally = tallyVotes(twoYes, "no");
  assert.equal(tally.approved, false);
  assert.match(tally.reason, /human founder rejected/);
});

test("does not approve while the human vote is pending", () => {
  const tally = tallyVotes(twoYes, "pending");
  assert.equal(tally.approved, false);
  assert.match(tally.reason, /Waiting for the human/);
});

test("rejects when only one juror says yes, even if the human approves", () => {
  const tally = tallyVotes(oneYes, "yes");
  assert.equal(tally.approved, false);
  assert.match(tally.reason, /at least 2 are required/);
});

test("refuses to evaluate approval on incomplete deliberation", () => {
  const tally = tallyVotes([verdict("investor", "yes")], "yes");
  assert.equal(tally.approved, false);
  assert.match(tally.reason, /Expected 3 juror verdicts/);
});

test("three yes votes still require the human", () => {
  const all = [
    verdict("investor", "yes"),
    verdict("technical-architect", "yes"),
    verdict("customer-advocate", "yes"),
  ];
  assert.equal(tallyVotes(all, "pending").approved, false);
  assert.equal(tallyVotes(all, "yes").approved, true);
});
