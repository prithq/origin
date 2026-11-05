/**
 * Agent activity.
 *
 * A single chronological feed of everything the studio did, filterable by
 * agent and by phase. Events delivered over SWITCH are marked, so the
 * distinction between local workflow events and transport-backed ones stays
 * visible.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import type { ActivityEvent } from "@origin/contracts";
import { api } from "../lib/api";
import { useEventStream } from "../lib/useEventStream";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  SectionHeader,
  Skeleton,
} from "../components/primitives";
import { ActivityRow } from "../components/ActivityRow";

export function ActivityPage() {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState<string>("all");
  const [onlySwitch, setOnlySwitch] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.activity(200);
      setEvents(result.events);
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
      setEvents((current) => (current ? [event, ...current].slice(0, 200) : current)),
  });

  const agents = useMemo(() => {
    const set = new Set<string>();
    for (const e of events ?? []) if (e.agentKey) set.add(e.agentKey);
    return [...set].sort();
  }, [events]);

  const filtered = useMemo(() => {
    let list = events ?? [];
    if (agent !== "all") list = list.filter((e) => e.agentKey === agent);
    if (onlySwitch) list = list.filter((e) => e.viaSwitch);
    return list;
  }, [events, agent, onlySwitch]);

  if (error && !events) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Agent activity</h1>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
            Structured events from every phase. Events that travelled over SWITCH are marked,
            so the collaboration layer is visible rather than implied.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          <RefreshCw size={13} /> Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-2xs text-muted">
          Agent
          <select
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            className="rounded border border-border bg-surface px-2 py-1 text-2xs text-content focus:border-border-strong focus:outline-none"
          >
            <option value="all">All agents</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>

        <label className="flex cursor-pointer items-center gap-1.5 text-2xs text-muted">
          <input
            type="checkbox"
            checked={onlySwitch}
            onChange={(e) => setOnlySwitch(e.target.checked)}
            className="h-3 w-3 accent-[hsl(var(--accent))]"
          />
          Only SWITCH-delivered
        </label>

        <span className="ml-auto text-2xs text-subtle">
          {filtered.length} event{filtered.length === 1 ? "" : "s"}
        </span>
      </div>

      <SectionHeader title="Feed" />

      {!events ? (
        <div className="space-y-1.5">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Activity size={18} />}
          title="No events match"
          description="Adjust the filters, or run a phase to produce activity."
        />
      ) : (
        <div className="rounded border border-border">
          <ul className="divide-y divide-border">
            {filtered.map((event) => (
              <ActivityRow key={event.id} event={event} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
