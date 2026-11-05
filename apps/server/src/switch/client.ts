/**
 * Minimal typed client for the SWITCH agent protocol.
 *
 * Everything here is implemented against the protocol as observed on a live
 * switch-core 0.31.0 deployment and cross-checked against its source:
 *
 *   - registration      POST /agents                       (registration key)
 *   - operation catalog GET  /agents/{id}/ops
 *   - operation call    POST /agents/{id}/ops/{name}        (agent key)
 *   - message post      POST /agents/{id}/message
 *   - event stream      GET  /agents/{id}/connection/ws     (WebSocket)
 *
 * Two wire details are easy to get wrong and are handled explicitly:
 *   1. Operation responses are wrapped as `{ result: ... }` for most
 *      operations.
 *   2. `connect_to_room` (and any room-bound operation) requires the
 *      `X-Switch-Connection-Id` header.
 */

import { WebSocket } from "ws";

export class SwitchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "SwitchError";
  }
}

export interface SwitchClientOptions {
  bridgeUrl: string;
  agentId: string;
  apiKey: string;
  /** Stable per-agent connection UUID, reused on every reconnect. */
  connectionId: string;
  onEvent: (frame: SwitchFrame) => void;
  onStateChange?: (state: SwitchConnectionState) => void;
  onError?: (error: Error) => void;
  clientVersion?: string;
}

export type SwitchConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "stopped";

/** The raw frame envelope. Note `event`, not `type`. */
export interface SwitchFrame {
  event: string;
  data?: Record<string, unknown>;
  id?: number;
}

export interface MessagePayload {
  addressed: boolean;
  sender: string;
  sender_name: string;
  sender_kind?: string | null;
  message_id: string;
  body: string;
  timestamp: number;
  thread_id?: string | null;
  attachments?: unknown[];
}

export interface IntegrationProfile {
  connection_model: "always_on" | "session_addressable" | "auto_session" | "session_passive";
  message_exchange: boolean;
  pre_invocation_mediation: unknown[];
  post_invocation_mediation: unknown[];
  event_reporting: string[];
}

const ALWAYS_ON_PROFILE: IntegrationProfile = {
  connection_model: "always_on",
  message_exchange: true,
  pre_invocation_mediation: [],
  post_invocation_mediation: [],
  event_reporting: [],
};

const HEARTBEAT_GRACE_MS = 15_000;
const MAX_RECONNECT_DELAY_MS = 20_000;

export class SwitchClient {
  private ws: WebSocket | null = null;
  private state: SwitchConnectionState = "disconnected";
  private lastSequence = 0;
  private generation: number | null = null;
  private readonly claimedRooms = new Set<string>();
  private intentionalClose = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPingAt = 0;

  constructor(private readonly opts: SwitchClientOptions) {}

  get connectionState(): SwitchConnectionState {
    return this.state;
  }

  get agentId(): string {
    return this.opts.agentId;
  }

  get roomIds(): string[] {
    return [...this.claimedRooms];
  }

  // -- HTTP ---------------------------------------------------------------

  private url(path: string): string {
    return `${this.opts.bridgeUrl.replace(/\/$/, "")}${path}`;
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    connectionBound = false,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.apiKey}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (connectionBound) headers["X-Switch-Connection-Id"] = this.opts.connectionId;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw text */
    }

    if (!res.ok) {
      throw new SwitchError(
        `${method} ${path} failed with ${res.status}`,
        res.status,
        parsed,
      );
    }
    return parsed as T;
  }

  /** Discover the operations this agent exposes. */
  async listOperations(): Promise<Record<string, unknown>> {
    const res = await this.request<{ operations: Record<string, unknown> }>(
      "GET",
      `/agents/${this.opts.agentId}/ops`,
    );
    return res.operations ?? {};
  }

  /**
   * Invoke an operation. Most operations wrap their payload in `result`;
   * this unwraps it so callers deal in the operation's own return shape.
   */
  async op<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
    connectionBound = true,
  ): Promise<T> {
    const res = await this.request<{ result?: T } | T>(
      "POST",
      `/agents/${this.opts.agentId}/ops/${name}`,
      args,
      connectionBound,
    );
    if (res && typeof res === "object" && "result" in (res as Record<string, unknown>)) {
      return (res as { result: T }).result;
    }
    return res as T;
  }

  /** Post a message without needing a connection (documented shortcut). */
  async postMessageToRoom(roomId: string, content: string): Promise<{ event_id: string }> {
    return this.request<{ event_id: string }>("POST", `/agents/${this.opts.agentId}/message`, {
      room_id: roomId,
      content,
    });
  }

  // -- WebSocket ----------------------------------------------------------

  connect(): void {
    if (this.state === "connected" || this.state === "connecting") return;
    this.intentionalClose = false;
    this.openSocket();
  }

  private setState(next: SwitchConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.opts.onStateChange?.(next);
  }

  private openSocket(): void {
    this.setState(this.reconnectAttempts === 0 ? "connecting" : "reconnecting");

    const params = new URLSearchParams({
      connection_id: this.opts.connectionId,
      scope: "all",
      filter: "all",
      start_from: String(this.lastSequence),
    });
    if (this.generation !== null) params.set("expected_generation", String(this.generation));
    if (this.opts.clientVersion) params.set("client_version", this.opts.clientVersion);

    const wsUrl = `${this.opts.bridgeUrl.replace(/^http/, "ws")}/agents/${
      this.opts.agentId
    }/connection/ws?${params.toString()}`;

    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
    });
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.setState("connected");
      this.startHeartbeatWatchdog();
    });

    ws.on("message", (raw) => {
      let frame: SwitchFrame;
      try {
        frame = JSON.parse(raw.toString()) as SwitchFrame;
      } catch {
        return;
      }
      this.handleFrame(frame);
    });

    ws.on("error", (err: Error) => {
      this.opts.onError?.(err);
    });

    ws.on("close", (code: number) => {
      this.stopHeartbeatWatchdog();
      this.ws = null;
      if (this.intentionalClose) {
        this.setState("stopped");
        return;
      }
      // 4401: bad credentials. 4409: taken over — do not reconnect.
      if (code === 4401 || code === 4409) {
        this.setState("stopped");
        this.opts.onError?.(
          new SwitchError(`SWITCH connection closed permanently (code ${code})`, code),
        );
        return;
      }
      this.setState("reconnecting");
      this.scheduleReconnect();
    });
  }

  private handleFrame(frame: SwitchFrame): void {
    // Control frames carry no sequence number.
    if (frame.event === "ping") {
      this.lastPingAt = Date.now();
      this.sendPong();
      return;
    }

    if (frame.event === "connection_state") {
      const data = frame.data ?? {};
      const cursor = typeof data.cursor === "number" ? data.cursor : 0;
      const generation = typeof data.generation === "number" ? data.generation : null;
      if (generation !== null) this.generation = generation;
      if (cursor > this.lastSequence) this.lastSequence = cursor;
      const rooms = Array.isArray(data.rooms) ? (data.rooms as string[]) : [];
      for (const room of rooms) this.claimedRooms.add(room);
      this.opts.onEvent(frame);
      return;
    }

    if (frame.event === "gap") {
      // Events were lost; the server gives us the resume point. Surfacing the
      // gap rather than pretending continuity is the honest behaviour.
      const resumedAt = (frame.data as { resumed_at?: number } | undefined)?.resumed_at;
      if (typeof resumedAt === "number" && resumedAt > this.lastSequence) {
        this.lastSequence = resumedAt;
      }
      this.opts.onEvent(frame);
      return;
    }

    if (frame.event === "evicted") {
      const code = (frame.data as { code?: string } | undefined)?.code;
      if (code === "taken_over") {
        // Final. Reconnecting would steal the connection back, forever.
        this.intentionalClose = true;
        this.setState("stopped");
      } else {
        this.scheduleReconnect();
      }
      this.opts.onEvent(frame);
      return;
    }

    if (typeof frame.id === "number" && frame.id > this.lastSequence) {
      this.lastSequence = frame.id;
    }
    this.opts.onEvent(frame);
  }

  private sendPong(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "pong", cursor: this.lastSequence }));
  }

  private startHeartbeatWatchdog(): void {
    this.stopHeartbeatWatchdog();
    this.lastPingAt = Date.now();
    // If pings stop arriving, the socket is dead even if no close event fired.
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastPingAt > HEARTBEAT_GRACE_MS) {
        this.ws?.terminate();
      }
    }, 5_000);
  }

  private stopHeartbeatWatchdog(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentionalClose) return;
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempts, MAX_RECONNECT_DELAY_MS);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  /** Connect this agent's session to a room, taking the room claim. */
  async joinRoom(roomId: string): Promise<SwitchRoomContext> {
    const ctx = await this.op<SwitchRoomContext>("connect_to_room", { room_id: roomId }, true);
    this.claimedRooms.add(roomId);
    return ctx;
  }

  async post(body: string, threadId?: string): Promise<{ event_id: string }> {
    return this.op<{ event_id: string }>("post_message", {
      body,
      ...(threadId ? { thread_id: threadId } : {}),
    });
  }

  async targeted(body: string, targetNames: string[], threadId?: string) {
    return this.op<{ event_id: string; target_statuses: Record<string, string> }>(
      "send_targeted_message",
      {
        body,
        target_names: targetNames,
        ...(threadId ? { thread_id: threadId } : {}),
      },
    );
  }

  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeatWatchdog();
    this.ws?.close();
    this.ws = null;
    this.setState("stopped");
  }
}

export interface SwitchRoomContext {
  agent_id: string;
  room_id: string;
  name: string;
  description: string;
  participants: SwitchParticipant[];
  instructions?: string;
}

export interface SwitchParticipant {
  id: string;
  name: string;
  /** "agent" | "user" — the human/agent discriminator. */
  type: string;
  agent_type?: string | null;
  status?: string | null;
  room_role?: string | null;
}

/** One entry from a room's real conversation history. */
export interface SwitchTranscriptEntry {
  id: string;
  kind: "message" | "room_join";
  sender: string;
  sender_name: string;
  body: string;
  timestamp: number;
  attachments?: unknown[];
  sender_kind?: string;
  on_behalf_of?: string;
}

export interface RegisteredAgent {
  id: string;
  api_key: string;
}

/**
 * Registers an agent. The API key is returned exactly once by SWITCH, so the
 * caller must persist it immediately.
 */
export async function registerAgent(
  bridgeUrl: string,
  registrationToken: string,
  input: {
    name: string;
    description: string;
    displayName: string;
    overwrite?: boolean;
  },
): Promise<RegisteredAgent> {
  const res = await fetch(`${bridgeUrl.replace(/\/$/, "")}/agents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${registrationToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: input.name,
      description: input.description,
      display_name: input.displayName,
      connector_type: "origin-custom",
      overwrite: input.overwrite ?? false,
      integration_profile: ALWAYS_ON_PROFILE,
    }),
  });

  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  if (!res.ok) {
    throw new SwitchError(`Agent registration failed with ${res.status}`, res.status, parsed);
  }
  return parsed as RegisteredAgent;
}

/** Probes the public health endpoint, which is the correct bridge base URL check. */
export async function probeBridge(bridgeUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${bridgeUrl.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export { ALWAYS_ON_PROFILE };
