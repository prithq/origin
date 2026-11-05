/**
 * A single place that records agent activity.
 *
 * Every agent action goes through here so the dashboard shows one consistent,
 * structured feed rather than several ad-hoc log formats. Events that arrived
 * over SWITCH are flagged `viaSwitch: true`; nothing else claims to be.
 */

import { randomUUID } from "node:crypto";
import type { AgentKey, ActivityEvent, RoomKey } from "@origin/contracts";
import { getStore } from "../db/store.js";
import { broadcast } from "./events.js";

export interface RecordActivityInput {
  phase: string;
  summary: string;
  level?: ActivityEvent["level"];
  agentKey?: AgentKey;
  room?: RoomKey;
  detail?: string;
  viaSwitch?: boolean;
  opportunityId?: string;
}

export async function recordActivity(input: RecordActivityInput): Promise<ActivityEvent> {
  const event: ActivityEvent = {
    id: `evt_${randomUUID()}`,
    at: new Date().toISOString(),
    phase: input.phase,
    summary: input.summary,
    level: input.level ?? "info",
    viaSwitch: input.viaSwitch ?? false,
    ...(input.agentKey ? { agentKey: input.agentKey } : {}),
    ...(input.room ? { room: input.room } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.opportunityId ? { opportunityId: input.opportunityId } : {}),
  };
  await getStore().recordActivity(event);
  broadcast({ type: "activity", data: event });
  return event;
}
