/**
 * Run bookkeeping.
 *
 * Long agent pipelines are started by an HTTP request and continue after the
 * response returns. This module tracks which opportunities are mid-flight so a
 * second request cannot start a duplicate run, and so the UI can show that work
 * is happening rather than appearing stuck.
 */

import type { WorkflowState } from "@origin/contracts";

export type RunKind = "discovery" | "research" | "jury" | "build" | "qa";

interface RunRecord {
  kind: RunKind;
  startedAt: number;
  /** Set once the run finishes, successfully or not. */
  finishedAt?: number;
  error?: string;
}

const active = new Map<string, RunRecord>();

/** Key for an opportunity-scoped run. Discovery is global. */
export function runKey(kind: RunKind, opportunityId?: string): string {
  return opportunityId ? `${kind}:${opportunityId}` : kind;
}

export function isRunning(kind: RunKind, opportunityId?: string): boolean {
  const record = active.get(runKey(kind, opportunityId));
  return Boolean(record && !record.finishedAt);
}

export function beginRun(kind: RunKind, opportunityId?: string): void {
  const key = runKey(kind, opportunityId);
  if (isRunning(kind, opportunityId)) {
    throw new Error(`A ${kind} run is already in progress`);
  }
  active.set(key, { kind, startedAt: Date.now() });
}

export function endRun(kind: RunKind, opportunityId?: string, error?: string): void {
  const key = runKey(kind, opportunityId);
  const record = active.get(key);
  if (record) {
    record.finishedAt = Date.now();
    if (error) record.error = error;
  }
}

export interface ActiveRun {
  kind: RunKind;
  opportunityId?: string;
  startedAt: string;
  elapsedMs: number;
}

export function listActiveRuns(): ActiveRun[] {
  const now = Date.now();
  return [...active.entries()]
    .filter(([, r]) => !r.finishedAt)
    .map(([key, r]) => {
      const [kind, opportunityId] = key.split(":");
      return {
        kind: kind as RunKind,
        ...(opportunityId ? { opportunityId } : {}),
        startedAt: new Date(r.startedAt).toISOString(),
        elapsedMs: now - r.startedAt,
      };
    });
}

/** Terminal states never accept a new run. */
export function isTerminalState(state: WorkflowState): boolean {
  return state === "COMPLETED" || state === "REJECTED" || state === "FAILED";
}
