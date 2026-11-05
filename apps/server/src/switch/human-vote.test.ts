import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateHumanVote, parseVoteIntent } from "./human-vote.js";
import type { MessagePayload, SwitchParticipant } from "./client.js";

const TOKEN = "opp_abc123";
const ROOM = "startup-council" as const;

function payload(overrides: Partial<MessagePayload> = {}): MessagePayload {
  return {
    addressed: false,
    sender: "@switch-mattermost-bridge1-user:localhost",
    sender_name: "user",
    sender_kind: null,
    message_id: "sw_msg_1",
    body: `APPROVE ${TOKEN}`,
    timestamp: 1_793_000_000_000,
    thread_id: null,
    attachments: [],
    ...overrides,
  };
}

const humans: SwitchParticipant[] = [
  { id: "u1", name: "user", type: "user" },
];
const agents: SwitchParticipant[] = [
  { id: "a1", name: "origin-investor", type: "agent" },
];

test("parses an approve command with token", () => {
  const intent = parseVoteIntent(`APPROVE ${TOKEN} looks good`);
  assert.ok(intent);
  assert.equal(intent.decision, "yes");
  assert.equal(intent.token, TOKEN);
  assert.equal(intent.note, "looks good");
});

test("parses a reject command", () => {
  const intent = parseVoteIntent(`REJECT ${TOKEN}`);
  assert.ok(intent);
  assert.equal(intent.decision, "no");
});

test("does not treat a sentence containing approve as a vote", () => {
  assert.equal(parseVoteIntent("I think we should approve this later"), null);
  assert.equal(parseVoteIntent("approved"), null);
  assert.equal(parseVoteIntent(""), null);
});

test("accepts a genuine bridged human vote", () => {
  const result = evaluateHumanVote(payload(), {
    roomKey: ROOM,
    expectedToken: TOKEN,
    participants: [...humans, ...agents],
  });
  assert.equal(result.ok, true);
  assert.equal(result.vote?.decision, "yes");
  assert.equal(result.vote?.switchSenderId, "@switch-mattermost-bridge1-user:localhost");
  assert.equal(result.vote?.switchMessageId, "sw_msg_1");
  assert.equal(result.vote?.channel, "mattermost");
});

test("refuses an agent sender even if it claims to be human", () => {
  const result = evaluateHumanVote(
    payload({
      sender: "@switch-agent-dae37d50:localhost",
      sender_name: "user",
      body: `APPROVE ${TOKEN}`,
    }),
    { roomKey: ROOM, expectedToken: TOKEN, participants: [...humans, ...agents] },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-a-human");
});

test("refuses a registered agent participant regardless of sender form", () => {
  const result = evaluateHumanVote(
    payload({
      sender: "@switch-agent-48de570b:localhost",
      sender_name: "origin-investor",
      body: `APPROVE ${TOKEN}`,
    }),
    {
      roomKey: ROOM,
      expectedToken: TOKEN,
      participants: [...humans, ...agents],
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-a-human");
});

test("refuses a vote for a different opportunity", () => {
  const result = evaluateHumanVote(payload({ body: "APPROVE opp_other" }), {
    roomKey: ROOM,
    expectedToken: TOKEN,
    participants: humans,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "wrong-opportunity");
});

test("refuses when a human and agent share a display name", () => {
  const result = evaluateHumanVote(payload({ sender_name: "sam" }), {
    roomKey: ROOM,
    expectedToken: TOKEN,
    participants: [
      { id: "u1", name: "sam", type: "user" },
      { id: "a1", name: "sam", type: "agent" },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ambiguous-identity");
});

test("refuses a sender who is not in the room", () => {
  const result = evaluateHumanVote(payload({ sender_name: "stranger" }), {
    roomKey: ROOM,
    expectedToken: TOKEN,
    participants: humans,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-a-human");
});

test("ignores ordinary room conversation", () => {
  const result = evaluateHumanVote(payload({ body: "Looks promising, let me think." }), {
    roomKey: ROOM,
    expectedToken: TOKEN,
    participants: humans,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-vote-intent");
});
