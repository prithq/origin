/**
 * A small, typed API client.
 *
 * Every response is typed against the shared contracts package, so the UI
 * cannot drift from the backend shape without a compile error. Errors are
 * surfaced as messages rather than swallowed, because the product is supposed
 * to be honest about failure.
 */

import type {
  ActivityEvent,
  Opportunity,
  WorkflowState,
} from "@origin/contracts";

const BASE = import.meta.env.VITE_API_URL ?? "";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch {
    throw new ApiError("Could not reach the Origin server", 0);
  }

  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw text */
  }

  if (!res.ok) {
    const message =
      typeof body === "object" && body && "message" in body
        ? String((body as { message: unknown }).message)
        : typeof body === "object" && body && "error" in body
          ? String((body as { error: unknown }).error)
          : `Request failed (${res.status})`;
    throw new ApiError(message, res.status, body);
  }

  return body as T;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  ok: boolean;
  llmMode: "live" | "mock";
  switchMode: "live" | "offline";
  liveLlm: boolean;
  liveSwitch: boolean;
  model: string;
  sandboxAvailable: boolean;
  switchReady: boolean;
  streamClients: number;
  activeRuns: ActiveRun[];
  at: string;
}

export interface ActiveRun {
  kind: string;
  opportunityId?: string;
  startedAt: string;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// SWITCH
// ---------------------------------------------------------------------------

export interface SwitchAgentStatus {
  key: string;
  displayName: string;
  switchAgentId: string | null;
  connectionState: string;
  rooms: string[];
}

export interface SwitchRoomStatus {
  key: string;
  name: string;
  switchRoomId: string | null;
  bridged: boolean;
  memberCount: number;
}

export interface SwitchStatus {
  mode: "live" | "offline";
  bridgeReachable: boolean;
  agents: SwitchAgentStatus[];
  rooms: SwitchRoomStatus[];
}

export interface TranscriptEntry {
  id: string;
  kind: "message" | "room_join";
  sender: string;
  sender_name: string;
  body: string;
  timestamp: number;
  sender_kind?: string;
}

export interface Participant {
  id: string;
  name: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

export interface OpportunityListItem {
  id: string;
  state: WorkflowState;
  title: string;
  problem: string;
  signalCount: number;
  confidence: number | null;
  verdicts: Array<{ juror: string; vote: "yes" | "no"; score: number }>;
  humanVote: "yes" | "no" | null;
  buildState: string | null;
  updatedAt: string;
}

export interface DashboardCounts {
  total: number;
  byState: Record<string, number>;
  approved: number;
  awaitingVote: number;
  building: number;
}

export interface DashboardResponse {
  switch: SwitchStatus | null;
  opportunities: Opportunity[];
  activity: ActivityEvent[];
  counts: DashboardCounts;
  activeRuns: ActiveRun[];
  workflow: WorkflowState[];
  sandboxAvailable: boolean;
}

export interface EvidenceRow {
  id: string;
  source: "hacker-news" | "github";
  title: string;
  url: string;
  retrievedAt: string;
  author?: string;
  excerpt: string;
  score?: number;
  commentCount?: number;
  tags: string[];
}

export interface TransitionRow {
  id: string;
  at: string;
  from: WorkflowState;
  to: WorkflowState;
  actor: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export const api = {
  health: () => request<HealthResponse>("/api/health"),

  dashboard: () => request<DashboardResponse>("/api/dashboard"),

  switchStatus: () => request<SwitchStatus>("/api/switch/status"),

  transcript: (roomKey: string, limit = 50) =>
    request<{ roomKey: string; entries: TranscriptEntry[]; live: boolean }>(
      `/api/switch/transcript/${roomKey}?limit=${limit}`,
    ),

  participants: () =>
    request<{ humans: Participant[]; agents: Participant[] }>(
      "/api/switch/participants",
    ),

  opportunities: () =>
    request<{ opportunities: OpportunityListItem[]; total: number }>(
      "/api/opportunities",
    ),

  opportunity: (id: string) =>
    request<{ opportunity: Opportunity }>(`/api/opportunities/${id}`),

  evidence: (id: string) =>
    request<{ evidence: EvidenceRow[]; count: number }>(
      `/api/opportunities/${id}/evidence`,
    ),

  transitions: (id: string) =>
    request<{ transitions: TransitionRow[] }>(
      `/api/opportunities/${id}/transitions`,
    ),

  activity: (limit = 100) =>
    request<{ events: ActivityEvent[]; activeRuns: ActiveRun[] }>(
      `/api/activity?limit=${limit}`,
    ),

  runDiscovery: () =>
    request<{ started: boolean }>("/api/discovery/run", { method: "POST" }),

  runResearch: (id: string) =>
    request<{ started: boolean }>(`/api/opportunities/${id}/research`, {
      method: "POST",
    }),

  runJury: (id: string) =>
    request<{ started: boolean }>(`/api/opportunities/${id}/jury`, {
      method: "POST",
    }),

  runBuild: (id: string) =>
    request<{ started: boolean }>(`/api/opportunities/${id}/build`, {
      method: "POST",
    }),

  vote: (id: string, decision: "yes" | "no", operatorToken: string, note?: string) =>
    request<{ approved: boolean; reason: string; opportunity: Opportunity }>(
      `/api/opportunities/${id}/vote`,
      {
        method: "POST",
        body: JSON.stringify({ decision, operatorToken, ...(note ? { note } : {}) }),
      },
    ),

  files: (id: string) =>
    request<{ files: Array<{ path: string; bytes: number }>; workspaceExists: boolean }>(
      `/api/opportunities/${id}/files`,
    ),

  file: (id: string, path: string) =>
    request<{ path: string; content: string }>(
      `/api/opportunities/${id}/file?path=${encodeURIComponent(path)}`,
    ),
};
