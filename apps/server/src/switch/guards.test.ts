import { test } from "node:test";
import assert from "node:assert/strict";
import { claimMessage, resetGuards } from "./guards.js";

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

test("claiming is independent per message id", () => {
  resetGuards();
  assert.equal(claimMessage("sw_a"), true);
  assert.equal(claimMessage("sw_b"), true);
  assert.equal(claimMessage("sw_a"), false);
  assert.equal(claimMessage("sw_b"), false);
});
