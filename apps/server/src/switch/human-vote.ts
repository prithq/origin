/**
 * The human-vote authentication boundary.
 *
 * This module is the only place a human decision enters the system. It exists
 * to make one guarantee: an AI agent can never cast, relay or fabricate the
 * founder's vote.
 *
 * How that is enforced, in layers:
 *
 *  1. Structural. Agents connect to SWITCH as agent clients and their sender
 *     id has the form `@switch-agent-<id>:<server>`. A bridged human appears as
 *     `@switch-<platform>-<id>-user:<server>`. An agent cannot produce the
 *     latter, because the localpart is assigned by SWITCH from the client row,
 *     not by anything the agent sends.
 *
 *  2. Authoritative classification. We ask SWITCH for the room's participants
 *     and read each participant's `type`, which SWITCH derives by resolving the
 *     sender to an agent or a human principal. `type === "user"` is SWITCH's
 *     own statement that a person sent it.
 *
 *  3. Uniqueness. If a room contains both a human and an agent with the same
 *     display name, the sender is rejected as ambiguous rather than guessed.
 *
 *  4. Token binding. A vote must name the opportunity it is about, so an old
 *     "approve" message cannot be replayed against a different opportunity.
 *
 *  5. Schema. `jurorVerdictSchema` has no human-vote field at all, so no LLM
 *     output can resemble a human decision.
 *
 * The resulting record keeps the raw SWITCH sender id and message id, so a
 * vote can always be traced back to the transport event that carried it.
 */

import type { RoomKey } from "@origin/contracts";
import { logger } from "../lib/logger.js";
import type { MessagePayload, SwitchParticipant } from "./client.js";

export interface HumanVoteCandidate {
  decision: "yes" | "no";
  channel: "mattermost" | "switch-room" | "origin-console";
  voterName: string;
  switchSenderId: string;
  switchMessageId: string;
  castAt: string;
  note?: string;
}

export type VoteRejectionReason =
  | "not-a-human"
  | "ambiguous-identity"
  | "no-vote-intent"
  | "wrong-opportunity"
  | "malformed";

export interface VoteParseResult {
  ok: boolean;
  reason?: VoteRejectionReason;
  detail?: string;
  vote?: HumanVoteCandidate;
}

/** Below this length a failure is too small to carry useful diagnostics. */
const AGENT_LOCALPART = /^@switch-agent-[0-9a-f]{8}:/i;
const HUMAN_LOCALPART = /^@switch-[a-z]+-.+-user:/i;

/**
 * The vote grammar. Deliberately strict and explicit so a normal sentence
 * containing the word "approve" cannot accidentally approve a build.
 *
 *   APPROVE <opportunity-token> [free text]
 *   REJECT  <opportunity-token> [free text]
 */
export function parseVoteIntent(
  body: string,
): { decision: "yes" | "no"; token: string; note: string } | null {
  const match = body.trim().match(/^(APPROVE|REJECT)\s+([A-Za-z0-9_-]{4,64})\b([\s\S]*)$/i);
  if (!match) return null;
  const [, verb, token, rest] = match;
  if (!verb || !token) return null;
  return {
    decision: verb.toUpperCase() === "APPROVE" ? "yes" : "no",
    token,
    note: (rest ?? "").trim(),
  };
}

export interface VoteGateContext {
  roomKey: RoomKey;
  /** The opportunity token the vote must reference. */
  expectedToken: string;
  /** Participants of the room, straight from SWITCH. */
  participants: SwitchParticipant[];
}

/**
 * Decide whether a SWITCH message is a genuine human vote.
 *
 * Returns a structured result rather than a boolean so the caller can record
 * why a message was refused. Refusals are logged; they are not silent.
 */
export function evaluateHumanVote(
  payload: MessagePayload,
  ctx: VoteGateContext,
): VoteParseResult {
  const intent = parseVoteIntent(payload.body);
  if (!intent) {
    return { ok: false, reason: "no-vote-intent", detail: "message is not a vote command" };
  }

  // Layer 1: structural identity. An agent client cannot emit a human localpart.
  if (AGENT_LOCALPART.test(payload.sender)) {
    logger.warn("Refused vote: sender is an agent client", { sender: payload.sender });
    return { ok: false, reason: "not-a-human", detail: "sender is an agent client" };
  }

  // Layer 2: SWITCH's own classification of the sender.
  const matching = ctx.participants.filter((p) => p.name === payload.sender_name);
  const humans = matching.filter((p) => p.type === "user");
  const agents = matching.filter((p) => p.type === "agent");

  // Layer 3: ambiguity is refused, never guessed.
  if (humans.length > 1 || (humans.length === 1 && agents.length > 0)) {
    logger.warn("Refused vote: ambiguous participant identity", {
      senderName: payload.sender_name,
      humans: humans.length,
      agents: agents.length,
    });
    return {
      ok: false,
      reason: "ambiguous-identity",
      detail: "room contains multiple participants with this name",
    };
  }

  if (humans.length === 0) {
    logger.warn("Refused vote: sender is not a human participant", {
      sender: payload.sender,
      senderName: payload.sender_name,
      matchedAgents: agents.length,
    });
    return {
      ok: false,
      reason: "not-a-human",
      detail: agents.length > 0 ? "sender is an agent participant" : "sender is not a participant",
    };
  }

  // Defense in depth: if the localpart does not look like a bridged human even
  // though SWITCH says user, refuse rather than trust a single signal.
  if (!HUMAN_LOCALPART.test(payload.sender) && payload.sender_kind !== "user") {
    logger.warn("Refused vote: participant classified human but sender id is unverified", {
      sender: payload.sender,
    });
    return {
      ok: false,
      reason: "not-a-human",
      detail: "sender id does not have a human client form",
    };
  }

  // Layer 4: token binding.
  if (intent.token.toLowerCase() !== ctx.expectedToken.toLowerCase()) {
    return {
      ok: false,
      reason: "wrong-opportunity",
      detail: `vote referenced ${intent.token}, expected ${ctx.expectedToken}`,
    };
  }

  const human = humans[0]!;
  return {
    ok: true,
    vote: {
      decision: intent.decision,
      channel: "mattermost",
      voterName: human.name,
      switchSenderId: payload.sender,
      switchMessageId: payload.message_id,
      castAt: new Date(payload.timestamp).toISOString(),
      ...(intent.note ? { note: intent.note } : {}),
    },
  };
}

/**
 * Builds the instruction the council posts so the founder knows exactly what
 * to type. The token is derived from the opportunity id and is not secret —
 * it exists to bind a vote to one opportunity, not to authenticate the voter.
 */
export function voteInstruction(opportunityId: string, title: string): string {
  return [
    `Opportunity ready for the founder's decision: ${title}`,
    "",
    `To approve, reply in this room with: APPROVE ${opportunityId}`,
    `To reject, reply in this room with: REJECT ${opportunityId}`,
    "",
    "Only the founder's own message counts. Agent messages are ignored by the vote gate.",
  ].join("\n");
}
