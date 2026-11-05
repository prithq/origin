import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { ROOM_SPECS, AGENT_SPECS } from "@origin/contracts";
import { config, isLiveLlm, isLiveSwitch } from "./config.js";
import { getStore } from "./db/store.js";
import { addStreamClient, heartbeat } from "./lib/events.js";
import { logger } from "./lib/logger.js";
import { SwitchHub } from "./switch/hub.js";
import type { SwitchStatus } from "./switch/hub.js";

export interface AppContext {
  hub: SwitchHub;
}

export function createApp(ctx: AppContext): express.Express {
  const app = express();

  app.use(
    cors({
      origin: [config.APP_BASE_URL, "http://localhost:5173", "http://127.0.0.1:5173"],
      credentials: false,
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      llmMode: config.LLM_MODE,
      switchMode: config.SWITCH_MODE,
      liveLlm: isLiveLlm,
      liveSwitch: isLiveSwitch,
      model: config.DEEPRELAY_MODEL,
      at: new Date().toISOString(),
    });
  });

  app.get("/api/switch/status", async (_req, res, next) => {
    try {
      const status = await ctx.hub.status();
      res.json(sanitiseSwitchStatus(status));
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/switch/rooms", (req, res) => {
    const status = {
      rooms: ROOM_SPECS.map((spec) => ({
        key: spec.key,
        name: spec.name,
        description: spec.description,
        switchRoomId: ctx.hub.roomId(spec.key),
        agents: spec.agents.map((key) => {
          const agent = AGENT_SPECS.find((a) => a.key === key);
          return { key, displayName: agent?.displayName ?? key };
        }),
      })),
    };
    res.json(status);
  });

  app.get("/api/activity", (req, res) => {
    const limit = Number(req.query.limit ?? 100);
    const opportunityId = typeof req.query.opportunityId === "string" ? req.query.opportunityId : undefined;
    res.json({ events: getStore().listActivity(Number.isFinite(limit) ? limit : 100, opportunityId) });
  });

  app.get("/api/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    addStreamClient(res);
  });

  app.get("/api/dashboard", async (_req, res, next) => {
    try {
      const store = getStore();
      let switchStatus: SwitchStatus | null = null;
      try {
        switchStatus = sanitiseSwitchStatus(await ctx.hub.status());
      } catch {
        switchStatus = null;
      }
      res.json({
        switch: switchStatus,
        opportunities: store.listOpportunities(),
        activity: store.listActivity(25),
        counts: summarise(store.listOpportunities()),
      });
    } catch (err) {
      next(err);
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: "not_found", path: req.path });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "validation_failed", issues: err.issues });
      return;
    }
    const message = err instanceof Error ? err.message : "Unexpected error";
    logger.error(`API error: ${message}`);
    res.status(500).json({ error: "internal_error", message });
  });

  const interval = setInterval(heartbeat, 25_000);
  interval.unref();

  return app;
}

/**
 * Strips credentials before anything leaves the server. The hub status already
 * omits API keys, but this function makes that guarantee explicit and local so
 * it is not lost if the hub shape changes.
 */
function sanitiseSwitchStatus(status: SwitchStatus): SwitchStatus {
  return {
    ...status,
    agents: status.agents.map((a) => ({
      key: a.key,
      displayName: a.displayName,
      switchAgentId: a.switchAgentId,
      connectionState: a.connectionState,
      rooms: a.rooms,
    })),
  };
}

function summarise(opportunities: ReturnType<ReturnType<typeof getStore>["listOpportunities"]>) {
  const byState: Record<string, number> = {};
  for (const o of opportunities) {
    byState[o.state] = (byState[o.state] ?? 0) + 1;
  }
  return {
    total: opportunities.length,
    byState,
    approved: opportunities.filter((o) => o.state === "APPROVED" || o.state === "COMPLETED").length,
    awaitingVote: opportunities.filter((o) => o.state === "AWAITING_HUMAN_VOTE").length,
    building: opportunities.filter((o) => o.state === "BUILDING" || o.state === "TESTING").length,
  };
}
