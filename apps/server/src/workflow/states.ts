/**
 * The workflow state machine.
 *
 * Transitions are declared as data and validated by `canTransition`, so the
 * legal graph exists in exactly one place. The UI renders states; it never
 * decides that a transition happened.
 */

import type { WorkflowState } from "@origin/contracts";

export interface TransitionRule {
  from: WorkflowState;
  to: WorkflowState;
  /** Who is permitted to trigger this edge. */
  actors: Array<"system" | "agent" | "human">;
  description: string;
}

export const TRANSITIONS: readonly TransitionRule[] = [
  {
    from: "IDLE",
    to: "DISCOVERING",
    actors: ["system", "human"],
    description: "A discovery run is started.",
  },
  {
    from: "DISCOVERING",
    to: "RESEARCHING",
    actors: ["system", "agent"],
    description: "Signals are clustered and a problem is selected for research.",
  },
  {
    from: "RESEARCHING",
    to: "JURY_REVIEW",
    actors: ["system", "agent"],
    description: "An opportunity brief exists and is sent to the jury.",
  },
  {
    from: "JURY_REVIEW",
    to: "AWAITING_HUMAN_VOTE",
    actors: ["system", "agent"],
    description: "Jurors have voted and the council is waiting for the founder.",
  },
  {
    from: "AWAITING_HUMAN_VOTE",
    to: "APPROVED",
    actors: ["human", "system"],
    description:
      "At least two of three AI jurors voted yes and the human founder voted yes.",
  },
  {
    from: "AWAITING_HUMAN_VOTE",
    to: "REJECTED",
    actors: ["human", "system"],
    description: "The approval conditions were not met.",
  },
  {
    from: "JURY_REVIEW",
    to: "REJECTED",
    actors: ["system", "agent", "human"],
    description: "The jury recommended rejection before a human vote was requested.",
  },
  {
    from: "APPROVED",
    to: "BUILDING",
    actors: ["system"],
    description: "The build workflow starts automatically after approval.",
  },
  {
    from: "BUILDING",
    to: "TESTING",
    actors: ["system", "agent"],
    description: "The builder finished and QA is running.",
  },
  {
    from: "TESTING",
    to: "BUILDING",
    actors: ["system", "agent"],
    description: "QA reported failures and requested a fix.",
  },
  {
    from: "TESTING",
    to: "COMPLETED",
    actors: ["system", "agent"],
    description: "QA passed and the MVP is complete.",
  },
  {
    from: "BUILDING",
    to: "FAILED",
    actors: ["system"],
    description: "The builder failed unrecoverably.",
  },
  {
    from: "TESTING",
    to: "FAILED",
    actors: ["system"],
    description: "QA retries were exhausted.",
  },
  {
    from: "DISCOVERING",
    to: "FAILED",
    actors: ["system"],
    description: "Discovery failed unrecoverably.",
  },
  {
    from: "RESEARCHING",
    to: "FAILED",
    actors: ["system"],
    description: "Research failed unrecoverably.",
  },
  {
    from: "JURY_REVIEW",
    to: "FAILED",
    actors: ["system"],
    description: "Jury deliberation failed unrecoverably.",
  },
  {
    from: "APPROVED",
    to: "FAILED",
    actors: ["system"],
    description: "The build could not be started.",
  },
];

export type TransitionActor = TransitionRule["actors"][number];

export function findRule(from: WorkflowState, to: WorkflowState): TransitionRule | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export function canTransition(
  from: WorkflowState,
  to: WorkflowState,
  actor: TransitionActor,
): { allowed: true; rule: TransitionRule } | { allowed: false; reason: string } {
  const rule = findRule(from, to);
  if (!rule) {
    return { allowed: false, reason: `No transition from ${from} to ${to}` };
  }
  if (!rule.actors.includes(actor)) {
    return {
      allowed: false,
      reason: `Transition ${from} -> ${to} cannot be performed by ${actor}`,
    };
  }
  return { allowed: true, rule };
}

export function nextStates(from: WorkflowState): WorkflowState[] {
  return TRANSITIONS.filter((t) => t.from === from).map((t) => t.to);
}
