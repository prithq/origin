import { test } from "node:test";
import assert from "node:assert/strict";
import { claimMessage, recordHop, hopCount, resetGuards, HopBudgetExceeded, MAX_HOPS } from "./guards.js";

test("a message is claimed once and refused the second time", () => {
  resetGuards();
  assert.equal(claimMessage("sw_1"), true);
  assert.equal(claimMessage("sw_1"), false);
  assert.equal(claimMessage("sw_2"), true);
});

test("an empty message id is never claimed", () => {
  resetGuards();
  assert.equal(claimMessage(""), false);
});

test("hops accumulate per opportunity", () => {
  resetGuards();
  recordHop("opp_a", "x", "y");
  recordHop("opp_a", "y", "z");
  recordHop("opp_b", "x", "y");
  assert.equal(hopCount("opp_a"), 2);
  assert.equal(hopCount("opp_b"), 1);
});

test("exceeding the hop budget stops the exchange", () => {
  resetGuards();
  for (let i = 0; i < MAX_HOPS; i += 1) {
    recordHop("opp_loop", "a", "b");
  }
  assert.throws(() => recordHop("opp_loop", "b", "a"), HopBudgetExceeded);
});

test("the budget is per opportunity, so one loop cannot block another", () => {
  resetGuards();
  for (let i = 0; i < MAX_HOPS; i += 1) recordHop("opp_1", "a", "b");
  assert.equal(recordHop("opp_2", "a", "b"), 1);
});
