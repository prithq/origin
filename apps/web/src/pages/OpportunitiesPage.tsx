/**
 * Opportunity list.
 *
 * A scannable table. The columns are the ones that actually distinguish
 * opportunities: what it is, how much evidence, how the jury split, and where
 * it is in the pipeline.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Boxes } from "lucide-react";
import { WORKFLOW_STATES, type WorkflowState } from "@origin/contracts";
import { api, type OpportunityListItem } from "../lib/api";
import {
  Button,
  EmptyState,
  ErrorState,
  relativeTime,
  ScoreBar,
  Skeleton,
  StateBadge,
  stateLabel,
} from "../components/primitives";

const FILTERS: Array<{ key: string; label: string; states: WorkflowState[] | null }> = [
  { key: "all", label: "All", states: null },
  { key: "vote", label: "Awaiting vote", states: ["AWAITING_HUMAN_VOTE"] },
  { key: "active", label: "In progress", states: ["DISCOVERING", "RESEARCHING", "JURY_REVIEW"] },
  { key: "build", label: "Building", states: ["APPROVED", "BUILDING", "TESTING"] },
  { key: "done", label: "Completed", states: ["COMPLETED", "REJECTED", "FAILED"] },
];

export function OpportunitiesPage() {
  const [items, setItems] = useState<OpportunityListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");

  const load = useCallback(async () => {
    try {
      const result = await api.opportunities();
      setItems(result.opportunities);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(load, 8000);
    return () => clearInterval(interval);
  }, [load]);

  if (error && !items) {
    return <ErrorState message={error} onRetry={() => void load()} />;
  }

  const activeFilter = FILTERS.find((f) => f.key === filter) ?? FILTERS[0]!;
  const visible =
    items?.filter((item) =>
      activeFilter.states ? activeFilter.states.includes(item.state) : true,
    ) ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Opportunities</h1>
        <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
          Every candidate problem the studio has found, with its evidence volume, jury result
          and build status.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => {
          const count =
            f.states === null
              ? (items?.length ?? 0)
              : (items?.filter((i) => f.states!.includes(i.state)).length ?? 0);
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={
                "rounded border px-2.5 py-1 text-2xs transition-colors " +
                (filter === f.key
                  ? "border-border-strong bg-surface text-content"
                  : "border-transparent text-muted hover:bg-surface hover:text-content")
              }
            >
              {f.label}
              <span className="tabular ml-1.5 text-subtle">{count}</span>
            </button>
          );
        })}
      </div>

      {!items ? (
        <div className="space-y-1.5">
          {WORKFLOW_STATES.slice(0, 4).map((s) => (
            <Skeleton key={s} className="h-11 w-full" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Boxes size={18} />}
          title={items.length === 0 ? "No opportunities yet" : "Nothing in this view"}
          description={
            items.length === 0
              ? "Run discovery from the Overview page to find real problems worth solving."
              : "Try a different filter, or run discovery to find more problems."
          }
          action={
            items.length === 0 ? (
              <Link to="/">
                <Button size="sm">Go to Overview</Button>
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full min-w-[46rem] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-bg-subtle">
                <Th>Opportunity</Th>
                <Th className="w-24">Signals</Th>
                <Th className="w-28">Jury</Th>
                <Th className="w-32">Confidence</Th>
                <Th className="w-32">State</Th>
                <Th className="w-24 text-right">Updated</Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => {
                const yes = item.verdicts.filter((v) => v.vote === "yes").length;
                return (
                  <tr
                    key={item.id}
                    className="border-b border-border last:border-b-0 transition-colors hover:bg-surface-hover"
                  >
                    <td className="px-3 py-2.5">
                      <Link
                        to={`/opportunities/${item.id}`}
                        className="block max-w-md truncate text-xs font-medium text-content hover:underline"
                      >
                        {item.title}
                      </Link>
                      <p className="mt-0.5 line-clamp-1 max-w-md text-2xs text-muted">
                        {item.problem}
                      </p>
                    </td>
                    <td className="tabular px-3 py-2.5 text-xs text-muted">
                      {item.signalCount}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {item.verdicts.length > 0 ? (
                        <span
                          className={
                            yes >= 2 ? "text-success" : "text-muted"
                          }
                        >
                          {yes}/3 yes
                        </span>
                      ) : (
                        <span className="text-subtle">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {item.confidence !== null ? (
                        <ScoreBar score={item.confidence} />
                      ) : (
                        <span className="text-2xs text-subtle">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <StateBadge state={item.state} />
                    </td>
                    <td className="px-3 py-2.5 text-right text-2xs text-subtle">
                      {relativeTime(item.updatedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {items && items.length > 0 ? (
        <p className="text-2xs text-subtle">
          Showing {visible.length} of {items.length}. States run{" "}
          {WORKFLOW_STATES.filter((s) => s !== "IDLE")
            .map((s) => stateLabel(s))
            .join(" → ")}
          .
        </p>
      ) : null}
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={
        "px-3 py-2 text-2xs font-medium uppercase tracking-wider text-subtle " +
        (className ?? "")
      }
    >
      {children}
    </th>
  );
}
