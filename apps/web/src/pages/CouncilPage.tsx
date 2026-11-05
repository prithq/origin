/**
 * Startup Council.
 *
 * The room where the founders and agents decide. It shows the three SWITCH
 * rooms, who is actually in them, and the live transcript read straight from
 * the transport, so a viewer can see this is real collaboration rather than a
 * rendered simulation.
 */

import { useCallback, useEffect, useState } from "react";
import { MessageSquare, RefreshCw, Users } from "lucide-react";
import { ROOM_SPECS } from "@origin/contracts";
import {
  api,
  type Participant,
  type SwitchStatus,
  type TranscriptEntry,
} from "../lib/api";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  formatTime,
  SectionHeader,
  Skeleton,
  StatusDot,
} from "../components/primitives";

const ROOM_LABEL: Record<string, string> = {
  "discovery-lab": "Discovery Lab",
  "startup-council": "Startup Council",
  "build-studio": "Build Studio",
};

export function CouncilPage() {
  const [status, setStatus] = useState<SwitchStatus | null>(null);
  const [participants, setParticipants] = useState<{
    humans: Participant[];
    agents: Participant[];
  } | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[] | null>(null);
  const [room, setRoom] = useState("startup-council");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, p, t] = await Promise.all([
        api.switchStatus(),
        api.participants(),
        api.transcript(room, 60),
      ]);
      setStatus(s);
      setParticipants(p);
      setTranscript(t.entries);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [room]);

  useEffect(() => {
    void load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load]);

  if (error && !status) {
    return <ErrorState message={error} onRetry={() => void load()} />;
  }

  const connected = status?.agents.filter((a) => a.connectionState === "connected") ?? [];

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Startup Council</h1>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
            Three SWITCH rooms carrying the whole workflow. The transcript below is read
            back from the SWITCH server, not reconstructed from Origin's own logs.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          <RefreshCw size={13} /> Refresh
        </Button>
      </div>

      {status && (!status.bridgeReachable || status.mode !== "live") ? (
        <div className="rounded border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
          SWITCH is not connected. Room content below may be stale. Origin does not simulate
          agent collaboration when the bridge is unavailable.
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-1">
              {ROOM_SPECS.map((spec) => (
                <button
                  key={spec.key}
                  type="button"
                  onClick={() => setRoom(spec.key)}
                  className={
                    "rounded border px-2.5 py-1 text-2xs transition-colors " +
                    (room === spec.key
                      ? "border-border-strong bg-surface text-content"
                      : "border-transparent text-muted hover:bg-surface hover:text-content")
                  }
                >
                  {ROOM_LABEL[spec.key] ?? spec.key}
                </button>
              ))}
            </div>
            <span className="flex items-center gap-1.5 text-2xs text-subtle">
              <StatusDot tone="success" pulse />
              reading live room
            </span>
          </div>

          {!transcript ? (
            <div className="space-y-1.5">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : transcript.length === 0 ? (
            <EmptyState
              icon={<MessageSquare size={18} />}
              title="This room is quiet"
              description="Messages appear here as agents work, and as you post in the linked chat channel."
            />
          ) : (
            <div className="max-h-[38rem] overflow-y-auto rounded border border-border">
              {/* Newest first: a demo should open on the latest activity, not on
                  the joining notices from when the room was created. */}
              <ul className="divide-y divide-border">
                {[...transcript].reverse().map((entry) => (
                  <TranscriptRow key={entry.id} entry={entry} />
                ))}
              </ul>
            </div>
          )}
        </section>

        <aside className="space-y-5">
          <div>
            <SectionHeader title="Participants" />
            <div className="rounded border border-border">
              <div className="border-b border-border px-3 py-2">
                <p className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-subtle">
                  <Users size={11} /> Humans
                </p>
                {participants?.humans.length ? (
                  <ul className="mt-1.5 space-y-1">
                    {participants.humans.map((h) => (
                      <li key={h.id} className="flex items-center gap-1.5 text-xs text-content">
                        <StatusDot tone="success" />
                        {h.name}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-2xs text-muted">
                    No human has joined the council room yet.
                  </p>
                )}
              </div>
              <div className="px-3 py-2">
                <p className="text-2xs font-medium uppercase tracking-wider text-subtle">
                  Agents ({participants?.agents.length ?? 0})
                </p>
                <ul className="mt-1.5 space-y-1">
                  {participants?.agents.map((a) => {
                    const live = connected.some((c) => c.switchAgentId === a.id);
                    return (
                      <li
                        key={a.id}
                        className="flex items-center justify-between gap-2 text-2xs"
                      >
                        <span className="flex items-center gap-1.5 text-muted">
                          <StatusDot tone={live ? "success" : "neutral"} />
                          {a.name}
                        </span>
                        <span className="text-subtle">{live ? "live" : "idle"}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          </div>

          <div>
            <SectionHeader title="Rooms" />
            <ul className="space-y-1.5">
              {status?.rooms.map((r) => (
                <li
                  key={r.key}
                  className="rounded border border-border px-3 py-2 text-2xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-content">{ROOM_LABEL[r.key] ?? r.name}</span>
                    {r.bridged ? <Badge tone="accent">bridged</Badge> : <Badge>internal</Badge>}
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-subtle">
                    <span className="truncate font-mono">{r.switchRoomId ?? "not created"}</span>
                    <span className="tabular">{r.memberCount} members</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <SectionHeader title="Agent connections" />
            <ul className="space-y-1">
              {status?.agents.map((a) => (
                <li key={a.key} className="flex items-center justify-between gap-2 text-2xs">
                  <span className="flex items-center gap-1.5 text-muted">
                    <StatusDot
                      tone={a.connectionState === "connected" ? "success" : "danger"}
                    />
                    {a.displayName}
                  </span>
                  <span className="text-subtle">{a.connectionState}</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

function TranscriptRow({ entry }: { entry: TranscriptEntry }) {
  if (entry.kind === "room_join") {
    return (
      <li className="px-3.5 py-2 text-2xs text-subtle">
        {entry.sender_name} joined the room
      </li>
    );
  }

  const isHuman = entry.sender.includes("-user:");

  return (
    <li className="px-3.5 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-1.5 text-2xs">
          <span className={isHuman ? "font-medium text-accent" : "text-content"}>
            {entry.sender_name}
          </span>
          {isHuman ? <Badge tone="accent">human</Badge> : <Badge>agent</Badge>}
        </span>
        <span className="tabular shrink-0 text-2xs text-subtle">
          {formatTime(new Date(entry.timestamp).toISOString())}
        </span>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted">
        {entry.body}
      </p>
    </li>
  );
}
