/**
 * Lightweight JSON persistence.
 *
 * Origin deliberately avoids a database for the five-hour build. What it does
 * not avoid is durability of the things that matter: every state transition,
 * every evidence item and every vote is appended to an event log and written
 * atomically. Nothing is held only in memory.
 */

import { mkdirSync, readFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  activityEventSchema,
  evidenceItemSchema,
  opportunitySchema,
  transitionSchema,
  type ActivityEvent,
  type EvidenceItem,
  type Opportunity,
  type Transition,
} from "@origin/contracts";
import { z } from "zod";
import { config } from "../config.js";

const evidenceFileSchema = z.object({
  version: z.literal(1),
  items: z.array(evidenceItemSchema),
});

const stateFileSchema = z.object({
  version: z.literal(1),
  opportunities: z.array(opportunitySchema),
  transitions: z.array(transitionSchema),
  activity: z.array(activityEventSchema),
});

export type PersistedState = z.infer<typeof stateFileSchema>;

const EMPTY_STATE: PersistedState = {
  version: 1,
  opportunities: [],
  transitions: [],
  activity: [],
};

export class Store {
  private readonly file = join(config.dataDir, "origin-state.json");
  private state: PersistedState;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor() {
    this.state = this.load();
  }

  private load(): PersistedState {
    if (!existsSync(this.file)) return structuredClone(EMPTY_STATE);
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      const parsed = stateFileSchema.safeParse(raw);
      if (!parsed.success) return structuredClone(EMPTY_STATE);
      return parsed.data;
    } catch {
      return structuredClone(EMPTY_STATE);
    }
  }

  /** Serialised atomic write: never leaves a half-written state file. */
  private async persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    });
    return this.writeQueue;
  }

  listOpportunities(): Opportunity[] {
    return [...this.state.opportunities];
  }

  getOpportunity(id: string): Opportunity | undefined {
    return this.state.opportunities.find((o) => o.id === id);
  }

  async upsertOpportunity(opportunity: Opportunity): Promise<void> {
    const index = this.state.opportunities.findIndex((o) => o.id === opportunity.id);
    if (index === -1) {
      this.state.opportunities.push(opportunity);
    } else {
      this.state.opportunities[index] = opportunity;
    }
    await this.persist();
  }

  async recordTransition(transition: Transition): Promise<void> {
    this.state.transitions.push(transition);
    await this.persist();
  }

  listTransitions(opportunityId?: string): Transition[] {
    return opportunityId
      ? this.state.transitions.filter((t) => t.opportunityId === opportunityId)
      : [...this.state.transitions];
  }

  async recordActivity(event: ActivityEvent): Promise<void> {
    this.state.activity.push(event);
    // Keep the activity log bounded so the file cannot grow without limit.
    if (this.state.activity.length > 2_000) {
      this.state.activity = this.state.activity.slice(-1_500);
    }
    await this.persist();
  }

  /**
   * Evidence is stored per opportunity, separate from the opportunity record.
   *
   * It is a snapshot: the sources an opportunity was judged on must not change
   * because someone ran discovery again.
   */
  async saveEvidence(opportunityId: string, items: EvidenceItem[]): Promise<void> {
    const path = join(config.dataDir, "evidence", `${opportunityId}.json`);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  }

  async loadEvidence(opportunityId: string): Promise<EvidenceItem[]> {
    const path = join(config.dataDir, "evidence", `${opportunityId}.json`);
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { items?: unknown };
      const result = evidenceFileSchema.safeParse(parsed);
      return result.success ? result.data.items : [];
    } catch {
      return [];
    }
  }

  listActivity(limit = 100, opportunityId?: string): ActivityEvent[] {
    const source = opportunityId
      ? this.state.activity.filter((a) => a.opportunityId === opportunityId)
      : this.state.activity;
    return source.slice(-limit).reverse();
  }

  async reset(): Promise<void> {
    this.state = structuredClone(EMPTY_STATE);
    await this.persist();
  }
}

let singleton: Store | null = null;

export function getStore(): Store {
  singleton ??= new Store();
  return singleton;
}
