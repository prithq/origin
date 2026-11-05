/**
 * The workflow engine.
 *
 * Owns every state transition. Nothing else in the system is allowed to write
 * an opportunity's state, which is why the tally, the build trigger and the
 * rejection path all funnel through `transition`.
 *
 * The engine also owns the SWITCH narration: each phase posts to the relevant
 * room as the agent that did the work, so the room transcript is a real record
 * of the run rather than a UI-only fiction.
 */

import { randomUUID } from "node:crypto";
import {
  type ActivityEvent,
  type AgentKey,
  type EvidenceItem,
  type Opportunity,
  type ProblemCluster,
  type RoomKey,
  type Transition,
  type WorkflowState,
} from "@origin/contracts";
import { broadcast } from "../lib/events.js";
import { recordActivity } from "../lib/activity.js";
import { logger } from "../lib/logger.js";
import { getStore } from "../db/store.js";
import { canTransition, type TransitionActor } from "./states.js";

export interface TransitionInput {
  opportunityId?: string;
  from: WorkflowState;
  to: WorkflowState;
  actor: TransitionActor;
  reason: string;
  /** Human-readable actor name for the transition log. */
  actorName: string;
}

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

/**
 * Records a transition, validating it against the declared graph first.
 * Illegal transitions throw rather than being written.
 */
export async function transition(input: TransitionInput): Promise<Transition> {
  const check = canTransition(input.from, input.to, input.actor);
  if (!check.allowed) {
    throw new WorkflowError(`Illegal transition: ${check.reason}`);
  }

  const record: Transition = {
    id: `tr_${randomUUID()}`,
    at: new Date().toISOString(),
    from: input.from,
    to: input.to,
    actor: input.actorName,
    reason: input.reason,
    ...(input.opportunityId ? { opportunityId: input.opportunityId } : {}),
  };

  await getStore().recordTransition(record);
  broadcast({
    type: "state",
    data: { opportunityId: input.opportunityId ?? "global", state: input.to },
  });
  logger.info(`Transition ${input.from} -> ${input.to} (${input.actor}): ${input.reason}`);
  return record;
}

/**
 * Applies a state change to an opportunity and its transition log together, so
 * the stored state and the audit trail cannot disagree.
 */
export async function setOpportunityState(
  opportunity: Opportunity,
  to: WorkflowState,
  actor: TransitionActor,
  actorName: string,
  reason: string,
): Promise<Opportunity> {
  if (opportunity.state === to) {
    throw new WorkflowError(`Opportunity ${opportunity.id} is already in ${to}`);
  }
  await transition({
    opportunityId: opportunity.id,
    from: opportunity.state,
    to,
    actor,
    actorName,
    reason,
  });

  const updated: Opportunity = {
    ...opportunity,
    state: to,
    updatedAt: new Date().toISOString(),
  };
  await getStore().upsertOpportunity(updated);
  broadcast({ type: "opportunity", data: updated });
  return updated;
}

export async function createOpportunity(cluster: ProblemCluster): Promise<Opportunity> {
  const now = new Date().toISOString();
  const opportunity: Opportunity = {
    id: `opp_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    state: "DISCOVERING",
    cluster,
    verdicts: [],
    createdAt: now,
    updatedAt: now,
  };
  await getStore().upsertOpportunity(opportunity);
  broadcast({ type: "opportunity", data: opportunity });
  return opportunity;
}

/**
 * Posts a phase update into a SWITCH room as the agent responsible for it.
 * A failure to post is logged but does not fail the workflow: the work itself
 * succeeded, and losing the narration should not discard it. The activity
 * record still shows the event, flagged as not delivered over SWITCH.
 */
export async function narrate(params: {
  post: (() => Promise<void>) | null;
  agentKey: AgentKey;
  room: RoomKey;
  phase: string;
  summary: string;
  detail?: string;
  opportunityId?: string;
  level?: ActivityEvent["level"];
}): Promise<void> {
  let viaSwitch = false;
  if (params.post) {
    try {
      await params.post();
      viaSwitch = true;
    } catch (err) {
      logger.warn(
        `Could not post ${params.phase} update to ${params.room}: ${(err as Error).message}`,
      );
    }
  }
  await recordActivity({
    phase: params.phase,
    summary: params.summary,
    agentKey: params.agentKey,
    room: params.room,
    viaSwitch,
    ...(params.detail ? { detail: params.detail } : {}),
    ...(params.opportunityId ? { opportunityId: params.opportunityId } : {}),
    ...(params.level ? { level: params.level } : {}),
  });
}

export interface DiscoveryRunSummary {
  opportunityIds: string[];
  evidenceCount: number;
  sourceErrors: Array<{ source: string; message: string }>;
}

export function summariseEvidence(items: EvidenceItem[]): string {
  const bySource = new Map<string, number>();
  for (const item of items) {
    bySource.set(item.source, (bySource.get(item.source) ?? 0) + 1);
  }
  return [...bySource.entries()].map(([source, count]) => `${count} from ${source}`).join(", ");
}

export const ENGINE_VERSION = "1.0.0";
