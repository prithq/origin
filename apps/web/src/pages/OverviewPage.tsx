/**
 * Overview.
 *
 * Answers three questions at a glance: what state is the studio in, what has it
 * found, and what is happening right now. Every number comes from the backend.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  Hammer,
  Play,
  RefreshCw,
  Users,
} from "lucide-react";
import type { ActivityEvent } from "@origin/contracts";
import { api, type DashboardResponse } from "../lib/api";
import { useEventStream } from "../lib/useEventStream";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  relativeTime,
  SectionHeader,
  Skeleton,
  StateBadge,
  StatusDot,
  ScoreBar,
} from "../components/primitives";
import { ActivityRow } from "../components/ActivityRow";
import { WorkflowStrip } from "../components/WorkflowStrip";

export function OverviewPage() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api.dashboard();
      setData(next);
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

  useEventStream({
    onActivity: (event) =>
      setData((current) =>
        current
          ? { ...current, activity: [event, ...current.activity].slice(0, 30) }
          : current,
      ),
    onOpportunity: () => void load(),
  });

  const startDiscovery = async () => {
    setStarting(true);
    try {
      await api.runDiscovery();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  if (!data && !error) {
    return <OverviewSkeleton />;
  }

  if (error && !data) {
    return <ErrorState message={error} onRetry={() => void load()} />;
  }

  if (!data) return null;

  const { counts, switch: switchStatus, opportunities, activity, activeRuns } = data;
  const inFlight = activeRuns.length > 0;
  const recent = opportunities
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
            Problems are found in public discussion, researched against real evidence, judged
            by three independent agents, then built only when the founder agrees.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void load()}
            title="Refresh"
          >
            <RefreshCw size={13} />
          </Button>
          <Button
            variant="primary"
            onClick={startDiscovery}
            loading={starting || (inFlight && counts.total > 0)}
            disabled={inFlight}
          >
            <Play size={14} />
            {inFlight ? "Run in progress" : "Run discovery"}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
          {error}
        </div>
      ) : null}

      {!data.sandboxAvailable ? (
        <div className="flex items-start gap-2 rounded border border-warning/30 bg-warning/5 px-3 py-2.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
          <p className="text-xs leading-relaxed text-warning">
            bubblewrap is not available, so the Builder will refuse to run. Origin will not
            execute generated code on the host.
          </p>
        </div>
      ) : null}

      <WorkflowStrip counts={counts} activeRuns={activeRuns} />

      <div className="grid gap-5 lg:grid-cols-3">
        <StatCard
          label="Opportunities"
          value={counts.total}
          detail={`${counts.byState.AWAITING_HUMAN_VOTE ?? 0} awaiting your vote`}
        />
        <StatCard
          label="Approved"
          value={counts.approved}
          detail={`${counts.building} building or testing`}
        />
        <StatCard
          label="Agents"
          value={switchStatus?.agents.filter((a) => a.connectionState === "connected").length ?? 0}
          detail={
            switchStatus
              ? `${switchStatus.rooms.filter((r) => r.switchRoomId).length} rooms on the bridge`
              : "bridge unavailable"
          }
          tone={switchStatus?.bridgeReachable ? "success" : "danger"}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        <section className="lg:col-span-3">
          <SectionHeader
            title="Recent opportunities"
            description="Each one began as a cluster of public complaints."
            action={
              <Link
                to="/opportunities"
                className="flex items-center gap-1 text-2xs text-muted transition-colors hover:text-content"
              >
                View all <ArrowRight size={12} />
              </Link>
            }
          />
          {recent.length === 0 ? (
            <EmptyState
              icon={<Play size={18} />}
              title="No opportunities yet"
              description="Run discovery to pull real problems from Hacker News and GitHub, then cluster them into candidates."
              action={
                <Button variant="primary" size="sm" onClick={startDiscovery} loading={starting}>
                  Run discovery
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border rounded border border-border">
              {recent.map((opportunity) => {
                const title = opportunity.brief?.title ?? opportunity.cluster.label;
                const yes = opportunity.verdicts.filter((v) => v.vote === "yes").length;
                return (
                  <li key={opportunity.id}>
                    <Link
                      to={`/opportunities/${opportunity.id}`}
                      className="block px-4 py-3 transition-colors hover:bg-surface-hover"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium text-content">{title}</p>
                          <p className="mt-1 line-clamp-2 text-2xs leading-relaxed text-muted">
                            {opportunity.cluster.problemStatement}
                          </p>
                        </div>
                        <StateBadge state={opportunity.state} />
                      </div>
                      <div className="mt-2 flex items-center gap-3 text-2xs text-subtle">
                        <span>{opportunity.cluster.signalCount} signals</span>
                        {opportunity.verdicts.length > 0 ? (
                          <span className="flex items-center gap-1">
                            <Users size={10} />
                            {yes}/3 jurors yes
                          </span>
                        ) : (
                          <span>no jury yet</span>
                        )}
                        {opportunity.build ? (
                          <span className="flex items-center gap-1">
                            <Hammer size={10} />
                            {opportunity.build.state}
                          </span>
                        ) : null}
                        <span className="ml-auto">{relativeTime(opportunity.updatedAt)}</span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="lg:col-span-2">
          <SectionHeader title="Agent activity" description="Structured events, not chat." />
          {activity.length === 0 ? (
            <EmptyState
              title="No activity yet"
              description="Agent events appear here as work happens."
            />
          ) : (
            <div className="max-h-[26rem] overflow-y-auto rounded border border-border">
              <ul className="divide-y divide-border">
                {activity.slice(0, 14).map((event) => (
                  <ActivityRow key={event.id} event={event} compact />
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: number;
  detail: string;
  tone?: "success" | "danger";
}) {
  return (
    <div className="rounded border border-border bg-surface px-4 py-3.5">
      <p className="text-2xs font-medium uppercase tracking-wider text-subtle">{label}</p>
      <p className="tabular mt-1.5 text-2xl font-semibold tracking-tight text-content">
        {value}
      </p>
      <p className="mt-1 flex items-center gap-1.5 text-2xs text-muted">
        {tone ? <StatusDot tone={tone} /> : null}
        {detail}
      </p>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-3 w-96" />
      </div>
      <Skeleton className="h-24 w-full" />
      <div className="grid gap-5 lg:grid-cols-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
      <div className="grid gap-5 lg:grid-cols-5">
        <Skeleton className="h-64 w-full lg:col-span-3" />
        <Skeleton className="h-64 w-full lg:col-span-2" />
      </div>
    </div>
  );
}

/** Re-exported for other pages that render the same feed. */
export type { ActivityEvent };
export { ScoreBar };
