/**
 * The SWITCH hub owns the lifetime of all nine Origin agents on the bridge.
 *
 * Each agent is a distinct SWITCH participant with its own registration, its
 * own API key and its own WebSocket. This is deliberate: SWITCH's participant
 * list, addressing rules, role leases and presence reporting only mean
 * anything if the agents are real participants rather than one bot posting
 * under many names.
 */

import { randomUUID } from "node:crypto";
import {
  AGENT_KEYS,
  AGENT_SPECS,
  ROOM_SPECS,
  type AgentKey,
  type RoomKey,
  type SwitchAgentRegistration,
  type SwitchRoomRecord,
} from "@origin/contracts";
import { config, isLiveSwitch } from "../config.js";
import { logger } from "../lib/logger.js";
import {
  SwitchClient,
  SwitchError,
  probeBridge,
  registerAgent,
  type MessagePayload,
  type SwitchFrame,
  type SwitchRoomContext,
} from "./client.js";
import { SwitchRegistryStore } from "./registry-store.js";

export interface SwitchStatus {
  mode: "live" | "offline";
  bridgeReachable: boolean;
  agents: Array<{
    key: AgentKey;
    displayName: string;
    switchAgentId: string | null;
    connectionState: string;
    rooms: string[];
  }>;
  rooms: Array<{
    key: RoomKey;
    name: string;
    switchRoomId: string | null;
    bridged: boolean;
    memberCount: number;
  }>;
}

export type SwitchEventHandler = (event: {
  agentKey: AgentKey;
  roomKey: RoomKey | null;
  payload: MessagePayload;
  frame: SwitchFrame;
}) => void | Promise<void>;

export interface HubOptions {
  onEvent?: SwitchEventHandler;
  /** Called once the hub is ready and all agents are joined. */
  onReady?: () => void;
  /**
   * Namespace for stable connection ids. SWITCH treats a repeated
   * connection_id as a takeover, so any two processes driving the same agents
   * must use different namespaces or they will evict each other forever.
   */
  connectionIdPrefix?: string;
}

const RECONNECT_ROOM_RETRY_MS = 3_000;

export class SwitchHub {
  private readonly registry = new SwitchRegistryStore();
  private readonly clients = new Map<AgentKey, SwitchClient>();
  private registrations = new Map<AgentKey, SwitchAgentRegistration>();
  private rooms = new Map<RoomKey, SwitchRoomRecord>();
  private bridgeReachable = false;
  private ready = false;
  private onEvent?: SwitchEventHandler;
  private reconnectTimers = new Map<AgentKey, NodeJS.Timeout>();
  private readonly connectionIdPrefix: string;

  constructor(opts: HubOptions = {}) {
    this.onEvent = opts.onEvent;
    this.connectionIdPrefix = opts.connectionIdPrefix ?? "origin-server";
  }

  get isReady(): boolean {
    return this.ready;
  }

  get mode(): "live" | "offline" {
    return isLiveSwitch ? "live" : "offline";
  }

  roomId(key: RoomKey): string | null {
    return this.rooms.get(key)?.switchRoomId ?? null;
  }

  agentRegistration(key: AgentKey): SwitchAgentRegistration | undefined {
    return this.registrations.get(key);
  }

  /** Look up an agent's SWITCH name (used for targeted handoffs). */
  agentName(key: AgentKey): string {
    return AGENT_SPECS.find((a) => a.key === key)?.name ?? key;
  }

  clientFor(key: AgentKey): SwitchClient | undefined {
    return this.clients.get(key);
  }

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (!isLiveSwitch) {
      logger.warn("SWITCH_MODE=offline — agent collaboration is mocked and labelled as such");
      this.ready = false;
      return;
    }

    this.registrations = this.registry.loadAgents();
    this.rooms = this.registry.loadRooms();

    this.bridgeReachable = await probeBridge(config.SWITCH_BRIDGE_URL);
    if (!this.bridgeReachable) {
      throw new SwitchError(
        `SWITCH bridge is not reachable at ${config.SWITCH_BRIDGE_URL}. ` +
          "Start switch-core or set SWITCH_MODE=offline for development.",
        0,
      );
    }

    await this.ensureAgents();
    await this.ensureRooms();
    await this.connectAll();
    this.ready = true;
    logger.info(
      `SWITCH hub ready: ${this.clients.size} agents across ${this.rooms.size} rooms`,
    );
  }

  /** Register any agent that has no persisted credential. */
  private async ensureAgents(): Promise<void> {
    for (const spec of AGENT_SPECS) {
      const existing = this.registrations.get(spec.key);
      if (existing && config.SWITCH_REUSE_AGENTS) {
        // Verify the stored key still works; a dead key means re-registration.
        const probe = new SwitchClient({
          bridgeUrl: config.SWITCH_BRIDGE_URL,
          agentId: existing.switchAgentId,
          apiKey: existing.apiKey,
          connectionId: randomUUID(),
          onEvent: () => {},
        });
        try {
          await probe.listOperations();
          logger.info(`Reusing SWITCH agent ${spec.name}`);
          continue;
        } catch (err) {
          if (err instanceof SwitchError && err.status === 401) {
            logger.warn(`Stored key for ${spec.name} is no longer valid; re-registering`);
          } else {
            throw err;
          }
        }
      }

      if (!config.SWITCH_REGISTRATION_TOKEN) {
        throw new SwitchError("SWITCH_REGISTRATION_TOKEN is not set", 401);
      }
      const reg = await registerAgent(
        config.SWITCH_BRIDGE_URL,
        config.SWITCH_REGISTRATION_TOKEN,
        {
          name: spec.name,
          description: spec.description,
          displayName: spec.displayName,
          overwrite: Boolean(existing),
        },
      );
      const record: SwitchAgentRegistration = {
        key: spec.key,
        switchAgentId: reg.id,
        apiKey: reg.api_key,
        registeredAt: new Date().toISOString(),
      };
      this.registrations.set(spec.key, record);
      // Persist immediately: SWITCH returns the key exactly once.
      this.registry.saveAgents(this.registrations);
      logger.info(`Registered SWITCH agent ${spec.name}`);
    }
  }

  /** Create the three rooms, bridged when a Mattermost bridge is available. */
  private async ensureRooms(): Promise<void> {
    const adminKey: AgentKey = "product-strategist";
    const admin = this.clientForRegistration(adminKey);
    if (!admin) throw new SwitchError("No agent available to create rooms", 500);

    const bridgeId = await this.resolveBridgeId(admin);
    const allAgentNames = AGENT_SPECS.map((a) => a.name);

    for (const spec of ROOM_SPECS) {
      const existing = this.rooms.get(spec.key);
      if (existing) {
        // Confirm the room still exists on this bridge.
        const stillThere = await this.roomExists(admin, existing.switchRoomId);
        if (stillThere) continue;
        logger.warn(`Room ${spec.name} is missing on the bridge; recreating`);
      }

      const memberNames = spec.agents.map(
        (k) => AGENT_SPECS.find((a) => a.key === k)?.name ?? k,
      );

      const created = await admin.op<{ id: string; name: string }>(
        "create_room",
        {
          name: spec.name,
          description: spec.description,
          agent_names: spec.key === "startup-council" ? allAgentNames : memberNames,
          ...(bridgeId ? { bridge_id: bridgeId, channel_type: "channel_public" } : { internal_only: true }),
        },
        false,
      );

      const record: SwitchRoomRecord = {
        key: spec.key,
        switchRoomId: created.id,
        name: created.name,
        createdAt: new Date().toISOString(),
        bridged: Boolean(bridgeId),
      };
      this.rooms.set(spec.key, record);
      this.registry.saveRooms(this.rooms);
      logger.info(
        `Created SWITCH room ${spec.name} (${created.id})${bridgeId ? " [bridged]" : " [internal]"}`,
      );
    }

    await this.defineRoles(admin);
    await this.linkRooms(admin);
  }

  private clientForRegistration(key: AgentKey): SwitchClient | null {
    const reg = this.registrations.get(key);
    if (!reg) return null;
    return new SwitchClient({
      bridgeUrl: config.SWITCH_BRIDGE_URL,
      agentId: reg.switchAgentId,
      apiKey: reg.apiKey,
      connectionId: randomUUID(),
      onEvent: () => {},
    });
  }

  private async resolveBridgeId(admin: SwitchClient): Promise<string | null> {
    if (config.SWITCH_MATTERMOST_BRIDGE_ID) return config.SWITCH_MATTERMOST_BRIDGE_ID;
    try {
      const bridges = await admin.op<Array<{ id: string; type: string; status: string }>>(
        "list_bridges",
        {},
        false,
      );
      const active = bridges.find((b) => b.status === "active" && b.type === "mattermost");
      return active?.id ?? null;
    } catch {
      return null;
    }
  }

  private async roomExists(admin: SwitchClient, roomId: string): Promise<boolean> {
    try {
      const rooms = await admin.op<Array<{ room_id: string }>>("list_all_rooms", {}, false);
      return rooms.some((r) => r.room_id === roomId);
    } catch {
      return false;
    }
  }

  /** Real SWITCH room roles, so handoffs can target a role, not a name. */
  private async defineRoles(admin: SwitchClient): Promise<void> {
    const councilId = this.roomId("startup-council");
    const discoveryId = this.roomId("discovery-lab");
    const buildId = this.roomId("build-studio");
    if (!councilId || !discoveryId || !buildId) return;

    const definitions: Array<{ roomId: string; name: string; instructions: string; exclusive: boolean }> = [
      {
        roomId: discoveryId,
        name: "scout",
        instructions:
          "Report only signals you actually retrieved. Every signal carries its source URL and retrieval timestamp.",
        exclusive: false,
      },
      {
        roomId: councilId,
        name: "researcher",
        instructions:
          "Ground every claim in the supplied evidence bundle. Name evidence gaps explicitly.",
        exclusive: false,
      },
      {
        roomId: councilId,
        name: "juror",
        instructions:
          "Assess the frozen evidence independently. Vote and reason; do not defer to other jurors.",
        exclusive: false,
      },
      {
        roomId: councilId,
        name: "chair",
        instructions:
          "Chair the deliberation. Name the jurors' disagreements. You do not cast a juror vote.",
        exclusive: true,
      },
      {
        roomId: buildId,
        name: "builder",
        instructions:
          "Implement only the approved MVP. Work inside the isolated workspace; never run generated code on the host.",
        exclusive: false,
      },
      {
        roomId: buildId,
        name: "qa",
        instructions:
          "Run the project's own tests. Report failures verbatim and request a fix from the builder.",
        exclusive: false,
      },
    ].slice(0, 4);

    for (const def of definitions) {
      const role = this.clientFor(def.roomId === councilId ? "product-strategist" : def.roomId === discoveryId ? "social-scout" : "builder");
      if (!role) continue;
      try {
        await role.op("define_role", {
          room_id: def.roomId,
          name: def.name,
          instructions: def.instructions,
          exclusive: def.exclusive,
        });
      } catch (err) {
        // Roles may already exist; that is not a startup failure.
        logger.debug(`Role ${def.name} not (re)defined: ${(err as Error).message}`);
      }
    }
  }

  private async linkRooms(admin: SwitchClient): Promise<void> {
    const discovery = this.roomId("discovery-lab");
    const council = this.roomId("startup-council");
    const build = this.roomId("build-studio");
    if (!discovery || !council || !build) return;
    const pairs: Array<[string, string, string]> = [
      [discovery, council, "promising problems are handed to the council"],
      [council, build, "approved opportunities are handed to the build studio"],
    ];
    for (const [source, target, label] of pairs) {
      try {
        await admin.op("link_rooms", { source_room_id: source, target_room_id: target, label });
      } catch (err) {
        logger.debug(`Room link not created: ${(err as Error).message}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  private async connectAll(): Promise<void> {
    const tasks: Array<Promise<void>> = [];
    for (const spec of AGENT_SPECS) {
      const reg = this.registrations.get(spec.key);
      if (!reg) continue;
      const roomId = this.roomId(spec.room);
      if (!roomId) continue;

      const client = new SwitchClient({
        bridgeUrl: config.SWITCH_BRIDGE_URL,
        agentId: reg.switchAgentId,
        apiKey: reg.apiKey,
        connectionId: `${this.connectionIdPrefix}-${reg.switchAgentId}`,
        clientVersion: "origin/0.1.0",
        onEvent: (frame) => void this.handleFrame(spec.key, frame),
        onStateChange: (state) => {
          logger.debug(`${spec.name} -> ${state}`);
          if (state === "reconnecting") this.scheduleRoomRejoin(spec.key, roomId);
        },
        onError: (err) => logger.error(`${spec.name} connection error: ${err.message}`),
      });

      this.clients.set(spec.key, client);
      tasks.push(
        (async () => {
          client.connect();
          await this.waitForConnection(client, 15_000);
          await client.joinRoom(roomId);
          logger.info(`${spec.name} joined ${spec.room}`);
        })(),
      );
    }
    await Promise.all(tasks);
  }

  private async waitForConnection(client: SwitchClient, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (client.connectionState !== "connected") {
      if (Date.now() > deadline) {
        throw new SwitchError("Timed out waiting for SWITCH connection", 0);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  private scheduleRoomRejoin(key: AgentKey, roomId: string): void {
    if (this.reconnectTimers.has(key)) return;
    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(key);
      const client = this.clients.get(key);
      if (!client || client.connectionState !== "connected") return;
      try {
        await client.joinRoom(roomId);
        logger.info(`${ACCOUNT_LABEL(key)} rejoined its room after reconnect`);
      } catch (err) {
        logger.warn(`${key} rejoin failed: ${(err as Error).message}`);
      }
    }, RECONNECT_ROOM_RETRY_MS);
    this.reconnectTimers.set(key, timer);
  }

  private async handleFrame(key: AgentKey, frame: SwitchFrame): Promise<void> {
    if (frame.event !== "message") return;
    const payload = frame.data?.payload as MessagePayload | undefined;
    if (!payload) return;
    const roomId = frame.data?.room_id as string | undefined;
    const roomKey = roomId ? this.roomKeyFor(roomId) : null;
    logger.debug(
      `${ACCOUNT_LABEL(key)} <- ${payload.sender_name} (addressed=${payload.addressed})`,
    );
    try {
      await this.onEvent?.({ agentKey: key, roomKey, payload, frame });
    } catch (err) {
      logger.error(`Event handler failed for ${key}: ${(err as Error).message}`);
    }
  }

  roomKeyFor(roomId: string): RoomKey | null {
    for (const [key, record] of this.rooms) {
      if (record.switchRoomId === roomId) return key;
    }
    return null;
  }

  /** The human participants currently present in a room. */
  async listParticipants(roomKey: RoomKey): Promise<SwitchRoomContext["participants"]> {
    const roomId = this.roomId(roomKey);
    if (!roomId) return [];
    const spec = ROOM_SPECS.find((r) => r.key === roomKey);
    const caller = this.clients.get(spec?.agents[0] ?? "product-strategist");
    if (!caller) return [];
    return caller.op<SwitchRoomContext["participants"]>("list_participants", {});
  }

  /** Post as a specific agent into its own room. */
  async postAs(key: AgentKey, body: string): Promise<void> {
    const client = this.clients.get(key);
    if (!client) throw new SwitchError(`Agent ${key} is not connected`, 0);
    await client.post(body);
  }

  async status(): Promise<SwitchStatus> {
    const rooms = await Promise.all(
      ROOM_SPECS.map(async (spec) => {
        const record = this.rooms.get(spec.key);
        let memberCount = 0;
        if (record) {
          try {
            memberCount = (await this.listParticipants(spec.key)).length;
          } catch {
            memberCount = 0;
          }
        }
        return {
          key: spec.key,
          name: spec.name,
          switchRoomId: record?.switchRoomId ?? null,
          bridged: record?.bridged ?? false,
          memberCount,
        };
      }),
    );

    return {
      mode: this.mode,
      bridgeReachable: this.bridgeReachable,
      agents: AGENT_KEYS.map((key) => {
        const spec = AGENT_SPECS.find((a) => a.key === key)!;
        const reg = this.registrations.get(key);
        const client = this.clients.get(key);
        return {
          key,
          displayName: spec.displayName,
          switchAgentId: reg?.switchAgentId ?? null,
          connectionState: client?.connectionState ?? "not-started",
          rooms: client?.roomIds ?? [],
        };
      }),
      rooms,
    };
  }

  async stop(): Promise<void> {
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    this.ready = false;
  }
}

function ACCOUNT_LABEL(key: AgentKey): string {
  return AGENT_SPECS.find((a) => a.key === key)?.displayName ?? key;
}
