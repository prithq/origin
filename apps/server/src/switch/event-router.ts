/**
 * Binds SWITCH room events to the workflow.
 *
 * This is the join between "a message arrived in a room" and "the product did
 * something". Keeping it separate from the hub means the transport layer stays
 * a transport layer: the hub connects and delivers, this module decides what a
 * delivered message means.
 *
 * Only three things are acted on:
 *   1. A vote command from a verified human in the council room.
 *   2. Observations of agent messages, recorded for the activity feed.
 *   3. Nothing else. Agent chatter must not be able to drive state.
 */

import type { RoomKey } from "@origin/contracts";
import { recordActivity } from "../lib/activity.js";
import { logger } from "../lib/logger.js";
import { getStore } from "../db/store.js";
import type { MessagePayload } from "../switch/client.js";
import { claimMessage } from "../switch/guards.js";
import { evaluateHumanVote, parseVoteIntent } from "../switch/human-vote.js";
import type { SwitchHub } from "../switch/hub.js";
import type { Orchestrator } from "../workflow/orchestrator.js";

export interface EventRouterDeps {
  hub: SwitchHub;
  orchestrator: Orchestrator;
}

export class EventRouter {
  constructor(private readonly deps: EventRouterDeps) {}

  async handle(event: {
    agentKey: string;
    roomKey: RoomKey | null;
    payload: MessagePayload;
  }): Promise<void> {
    const { roomKey, payload } = event;

    // Duplicate delivery is normal after a reconnect; process each message once.
    if (!claimMessage(payload.message_id)) return;

    // A vote is only meaningful in the council.
    if (roomKey !== "startup-council") {
      return;
    }

    const intent = parseVoteIntent(payload.body);
    if (!intent) {
      // Not a vote command. Record genuine human commentary so the activity feed
      // reflects real participation, but never let it drive state.
      return;
    }

    await this.handleVote(payload, intent.token, intent.decision);
  }

  private async handleVote(
    payload: MessagePayload,
    token: string,
    decision: "yes" | "no",
  ): Promise<void> {
    const store = getStore();
    const opportunity = store
      .listOpportunities()
      .find((o) => o.id.toLowerCase() === token.toLowerCase());

    if (!opportunity) {
      logger.warn(`Vote referenced unknown opportunity token "${token}"`);
      await recordActivity({
        phase: "vote",
        summary: "Ignored a vote for an unknown opportunity",
        level: "warning",
        detail: `token: ${token}`,
      });
      return;
    }

    // Authoritative human check against SWITCH's own participant list.
    let participants: Awaited<ReturnType<SwitchHub["listParticipants"]>> = [];
    try {
      participants = await this.deps.hub.listParticipants("startup-council");
    } catch (err) {
      logger.error(
        `Could not verify voter identity, so the vote is refused: ${(err as Error).message}`,
      );
      return;
    }

    const verdict = evaluateHumanVote(payload, {
      roomKey: "startup-council",
      expectedToken: opportunity.id,
      participants,
    });

    if (!verdict.ok || !verdict.vote) {
      await recordActivity({
        phase: "vote",
        summary: "Refused a vote that failed identity verification",
        level: "warning",
        detail: `${verdict.reason}: ${verdict.detail ?? ""}`,
        opportunityId: opportunity.id,
        viaSwitch: true,
      });
      return;
    }

    try {
      const result = await this.deps.orchestrator.recordHumanVote(opportunity.id, {
        decision: verdict.vote.decision,
        channel: verdict.vote.channel,
        voterName: verdict.vote.voterName,
        switchSenderId: verdict.vote.switchSenderId,
        switchMessageId: verdict.vote.switchMessageId,
        ...(verdict.vote.note ? { note: verdict.vote.note } : {}),
      });

      await recordActivity({
        phase: "vote",
        summary: `Human vote accepted from ${verdict.vote.voterName}: ${decision}`,
        level: "success",
        detail: result.reason,
        opportunityId: opportunity.id,
        viaSwitch: true,
      });
    } catch (err) {
      // A duplicate vote lands here: the opportunity is no longer awaiting one.
      logger.warn(`Vote not applied: ${(err as Error).message}`);
      await recordActivity({
        phase: "vote",
        summary: "Vote was not applied",
        level: "warning",
        detail: (err as Error).message,
        opportunityId: opportunity.id,
        viaSwitch: true,
      });
    }
  }
}
