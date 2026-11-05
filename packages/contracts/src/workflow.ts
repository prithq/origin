/**
 * Canonical workflow states. The backend is the only authority over these;
 * the frontend renders them but never computes a transition.
 */
export const WORKFLOW_STATES = [
  "IDLE",
  "DISCOVERING",
  "RESEARCHING",
  "JURY_REVIEW",
  "AWAITING_HUMAN_VOTE",
  "APPROVED",
  "BUILDING",
  "TESTING",
  "COMPLETED",
  "REJECTED",
  "FAILED",
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** States from which no further automatic transition occurs. */
export const TERMINAL_STATES: readonly WorkflowState[] = [
  "COMPLETED",
  "REJECTED",
  "FAILED",
];

export function isTerminal(state: WorkflowState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * Ordered happy-path progression used by the UI to render workflow progress.
 * REJECTED and FAILED are branches off this path, not steps on it.
 */
export const HAPPY_PATH: readonly WorkflowState[] = [
  "DISCOVERING",
  "RESEARCHING",
  "JURY_REVIEW",
  "AWAITING_HUMAN_VOTE",
  "APPROVED",
  "BUILDING",
  "TESTING",
  "COMPLETED",
];
