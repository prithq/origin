/**
 * The workflow strip.
 *
 * Shows where the studio is in the journey. The steps are the real backend
 * states, and an active run is highlighted rather than faked with a spinner in
 * a random place.
 */

import { HAPPY_PATH } from "@origin/contracts";
import type { DashboardCounts, ActiveRun } from "../lib/api";
import { cx, stateLabel } from "./primitives";

export function WorkflowStrip({
  counts,
  activeRuns,
}: {
  counts: DashboardCounts;
  activeRuns: ActiveRun[];
}) {
  const activeKinds = new Set(activeRuns.map((r) => r.kind));

  // Which step the studio is currently working on, if any.
  const activeState =
    activeKinds.has("build") || activeKinds.has("qa")
      ? "BUILDING"
      : activeKinds.has("jury")
        ? "JURY_REVIEW"
        : activeKinds.has("research")
          ? "RESEARCHING"
          : activeKinds.has("discovery")
            ? "DISCOVERING"
            : null;

  return (
    <div className="rounded border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-x-1 gap-y-2 p-3">
        {HAPPY_PATH.map((state, index) => {
          const isActive = activeState === state;
          const count = counts.byState[state] ?? 0;
          const reached = count > 0;

          return (
            <div key={state} className="flex items-center">
              <div
                className={cx(
                  "flex items-center gap-1.5 rounded px-2 py-1 text-2xs transition-colors",
                  isActive
                    ? "bg-accent/10 text-accent"
                    : reached
                      ? "text-content"
                      : "text-subtle",
                )}
              >
                <span
                  className={cx(
                    "flex h-4 w-4 items-center justify-center rounded-full border text-[9px] tabular",
                    isActive
                      ? "border-accent text-accent"
                      : reached
                        ? "border-border-strong text-muted"
                        : "border-border text-subtle",
                  )}
                >
                  {index + 1}
                </span>
                <span className="whitespace-nowrap">{stateLabel(state)}</span>
                {count > 0 ? (
                  <span className="tabular text-subtle">({count})</span>
                ) : null}
              </div>
              {index < HAPPY_PATH.length - 1 ? (
                <span className="px-0.5 text-subtle">/</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
