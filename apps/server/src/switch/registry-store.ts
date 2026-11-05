/**
 * Persists SWITCH agent credentials and room ids.
 *
 * This file is a credential store. It lives under DATA_DIR (gitignored) and is
 * written with owner-only permissions. It is never served to the frontend: the
 * API exposes agent ids and connection states, never API keys.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ROOM_KEYS,
  AGENT_KEYS,
  switchAgentRegistrationSchema,
  switchRoomRecordSchema,
  type AgentKey,
  type RoomKey,
  type SwitchAgentRegistration,
  type SwitchRoomRecord,
} from "@origin/contracts";
import { z } from "zod";
import { config } from "../config.js";

const agentsFileSchema = z.object({
  version: z.literal(1),
  agents: z.array(switchAgentRegistrationSchema),
});

const roomsFileSchema = z.object({
  version: z.literal(1),
  rooms: z.array(switchRoomRecordSchema),
});

export class SwitchRegistryStore {
  private readonly agentPath = join(config.dataDir, "switch-agents.json");
  private readonly roomPath = join(config.dataDir, "switch-rooms.json");

  loadAgents(): Map<AgentKey, SwitchAgentRegistration> {
    const map = new Map<AgentKey, SwitchAgentRegistration>();
    const data = readJson(this.agentPath);
    if (!data) return map;
    const parsed = agentsFileSchema.safeParse(data);
    if (!parsed.success) return map;
    for (const entry of parsed.data.agents) {
      if ((AGENT_KEYS as readonly string[]).includes(entry.key)) {
        map.set(entry.key, entry);
      }
    }
    return map;
  }

  saveAgents(agents: Map<AgentKey, SwitchAgentRegistration>): void {
    writeJson(this.agentPath, { version: 1, agents: [...agents.values()] });
  }

  loadRooms(): Map<RoomKey, SwitchRoomRecord> {
    const map = new Map<RoomKey, SwitchRoomRecord>();
    const data = readJson(this.roomPath);
    if (!data) return map;
    const parsed = roomsFileSchema.safeParse(data);
    if (!parsed.success) return map;
    for (const entry of parsed.data.rooms) {
      if ((ROOM_KEYS as readonly string[]).includes(entry.key)) {
        map.set(entry.key, entry);
      }
    }
    return map;
  }

  saveRooms(rooms: Map<RoomKey, SwitchRoomRecord>): void {
    writeJson(this.roomPath, { version: 1, rooms: [...rooms.values()] });
  }
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
}
