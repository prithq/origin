/**
 * HTTP API.
 *
 * Every request body is validated with Zod. Errors are structured and never
 * leak internals. Read endpoints return exactly what the dashboard needs, which
 * keeps the frontend free of derivation logic it could get wrong.
 */

import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import { AGENT_SPECS, ROOM_SPECS, type Opportunity } from "@origin/contracts";
import { config, isLiveLlm, isLiveSwitch } from "./config.js";
import { getStore } from "./db/store.js";
import { addStreamClient, heartbeat, streamClientCount } from "./lib/events.js";
import { logger } from "./lib/logger.js";
import { listActiveRuns } from "./workflow/runs.js";
import { HAPPY_PATH } from "@origin/contracts";
import type { SwitchHub } from "./switch/hub.js";
import type { Orchestrator } from "./workflow/orchestrator.js";
import { isSandboxAvailable } from "./build/sandbox.js";
import { readWorkspaceFile, workspaceExists } from "./build/pipeline.js";

export interface AppContext {
  hub: SwitchHub;
  orchestrator: Orchestrator;
}

const voteBodySchema = z.object({
  decision: z.enum(["yes", "no"]),
  operatorToken: z.string().min(1, "operator token is required"),
  note: z.string().max(2_000).optional(),
});

/** Async route helper so rejections reach the error middleware. */
function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/**
 * Reads a required route parameter. Express types it as possibly undefined
 * under `noUncheckedIndexedAccess`; validating here keeps handlers free of
 * non-null assertions.
 */
function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing route parameter "${name}"`);
  }
  return value;
}

export function createApp(ctx: AppContext): express.Express {
  const app = express();

  app.use(
    cors({
      origin: [config.APP_BASE_URL, "http://localhost:5173", "http://127.0.0.1:5173"],
      credentials: false,
    }),
  );
  app.use(express.json({ limit: "2mb" }));

  // ---------------------------------------------------------------------
  // Health and runtime
  // ---------------------------------------------------------------------

  app.get("/api/health", async (_req, res) => {
    res.json({
      ok: true,
      llmMode: config.LLM_MODE,
      switchMode: config.SWITCH_MODE,
      liveLlm: isLiveLlm,
      liveSwitch: isLiveSwitch,
      model: config.DEEPRELAY_MODEL,
      sandboxAvailable: isSandboxAvailable(),
      switchReady: ctx.hub.isReady,
      streamClients: streamClientCount(),
      activeRuns: listActiveRuns(),
      at: new Date().toISOString(),
    });
  });

  // ---------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------

  app.get(
    "/api/dashboard",
    asyncRoute(async (_req, res) => {
      const store = getStore();
      const opportunities = store.listOpportunities();

      let switchStatus = null;
      try {
        switchStatus = sanitise(await ctx.hub.status());
      } catch (err) {
        logger.debug(`Switch status unavailable: ${(err as Error).message}`);
      }

      res.json({
        switch: switchStatus,
        opportunities,
        activity: store.listActivity(30),
        counts: summarise(opportunities),
        activeRuns: listActiveRuns(),
        workflow: HAPPY_PATH,
        sandboxAvailable: isSandboxAvailable(),
      });
    }),
  );

  // ---------------------------------------------------------------------
  // SWITCH
  // ---------------------------------------------------------------------

  app.get(
    "/api/switch/status",
    asyncRoute(async (_req, res) => {
      res.json(sanitise(await ctx.hub.status()));
    }),
  );

  app.get("/api/switch/rooms", (_req, res) => {
    res.json({
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
    });
  });

  app.get(
    "/api/switch/transcript/:roomKey",
    asyncRoute(async (req, res) => {
      const roomKey = param(req, "roomKey");
      const known = ROOM_SPECS.some((r) => r.key === roomKey);
      if (!known) {
        res.status(404).json({ error: "unknown_room", roomKey });
        return;
      }
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const entries = await ctx.hub.readTranscript(
        roomKey as (typeof ROOM_SPECS)[number]["key"],
        limit,
      );
      res.json({ roomKey, entries, live: ctx.hub.isReady });
    }),
  );

  app.get(
    "/api/switch/participants",
    asyncRoute(async (_req, res) => {
      const participants = await ctx.hub.listParticipants("startup-council");
      res.json({
        humans: participants.filter((p) => p.type === "user"),
        agents: participants.filter((p) => p.type === "agent"),
      });
    }),
  );

  // ---------------------------------------------------------------------
  // Opportunities
  // ---------------------------------------------------------------------

  app.get("/api/opportunities", (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const all = getStore().listOpportunities();
    const filtered = state ? all.filter((o) => o.state === state) : all;
    res.json({
      opportunities: filtered.map(toListItem),
      total: filtered.length,
    });
  });

  app.get("/api/opportunities/:id", (req, res) => {
    const opportunity = getStore().getOpportunity(param(req, "id"));
    if (!opportunity) {
      res.status(404).json({ error: "not_found", id: param(req, "id") });
      return;
    }
    res.json({ opportunity });
  });

  app.get(
    "/api/opportunities/:id/evidence",
    asyncRoute(async (req, res) => {
      const opportunity = getStore().getOpportunity(param(req, "id"));
      if (!opportunity) {
        res.status(404).json({ error: "not_found", id: param(req, "id") });
        return;
      }
      const evidence = await getStore().loadEvidence(param(req, "id"));
      res.json({ evidence, count: evidence.length });
    }),
  );

  app.get("/api/opportunities/:id/transitions", (req, res) => {
    res.json({ transitions: getStore().listTransitions(param(req, "id")) });
  });

  // ---------------------------------------------------------------------
  // Workflow actions
  // ---------------------------------------------------------------------

  app.post(
    "/api/discovery/run",
    asyncRoute(async (_req, res) => {
      // Started, not awaited: discovery takes a minute and the UI follows SSE.
      void ctx.orchestrator.runDiscoveryPhase().catch((err) => {
        logger.error(`Discovery run failed: ${(err as Error).message}`);
      });
      res.status(202).json({ started: true, message: "Discovery run started" });
    }),
  );

  app.post(
    "/api/opportunities/:id/research",
    asyncRoute(async (req, res) => {
      void ctx.orchestrator.runResearchPhase(param(req, "id")).catch((err) => {
        logger.error(`Research failed for ${param(req, "id")}: ${(err as Error).message}`);
      });
      res.status(202).json({ started: true, id: param(req, "id") });
    }),
  );

  app.post(
    "/api/opportunities/:id/jury",
    asyncRoute(async (req, res) => {
      void ctx.orchestrator.runJuryPhase(param(req, "id")).catch((err) => {
        logger.error(`Jury failed for ${param(req, "id")}: ${(err as Error).message}`);
      });
      res.status(202).json({ started: true, id: param(req, "id") });
    }),
  );

  app.post(
    "/api/opportunities/:id/build",
    asyncRoute(async (req, res) => {
      const opportunity = getStore().getOpportunity(param(req, "id"));
      if (!opportunity) {
        res.status(404).json({ error: "not_found", id: param(req, "id") });
        return;
      }
      if (opportunity.state !== "APPROVED") {
        res.status(409).json({
          error: "invalid_state",
          message: `Build requires state APPROVED; this opportunity is ${opportunity.state}`,
        });
        return;
      }
      void ctx.orchestrator.startBuild(param(req, "id")).catch((err) => {
        logger.error(`Build failed for ${param(req, "id")}: ${(err as Error).message}`);
      });
      res.status(202).json({ started: true, id: param(req, "id") });
    }),
  );

  /**
   * The console vote path.
   *
   * It requires the operator token, and it is recorded with channel
   * `origin-console` so a reader can always tell which human surface a decision
   * came through. It is a human-authenticated fallback, not an agent shortcut.
   */
  app.post(
    "/api/opportunities/:id/vote",
    asyncRoute(async (req, res) => {
      const body = voteBodySchema.parse(req.body);

      if (!config.HUMAN_OPERATOR_TOKEN) {
        res.status(503).json({
          error: "operator_token_not_configured",
          message:
            "HUMAN_OPERATOR_TOKEN is not set, so the console vote path is disabled. Vote in the SWITCH room instead.",
        });
        return;
      }
      if (body.operatorToken !== config.HUMAN_OPERATOR_TOKEN) {
        res.status(401).json({ error: "invalid_operator_token" });
        return;
      }

      const result = await ctx.orchestrator.recordHumanVote(param(req, "id"), {
        decision: body.decision,
        channel: "origin-console",
        voterName: "Founder",
        ...(body.note ? { note: body.note } : {}),
      });

      res.json({
        approved: result.approved,
        reason: result.reason,
        opportunity: result.opportunity,
      });
    }),
  );

  // ---------------------------------------------------------------------
  // Build artifacts
  // ---------------------------------------------------------------------

  app.get("/api/opportunities/:id/files", (req, res) => {
    const opportunity = getStore().getOpportunity(param(req, "id"));
    if (!opportunity) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({
      files: opportunity.build?.files ?? [],
      workspaceExists: workspaceExists(param(req, "id")),
    });
  });

  app.get("/api/opportunities/:id/file", (req, res) => {
    const path = typeof req.query.path === "string" ? req.query.path : null;
    if (!path) {
      res.status(400).json({ error: "path_required" });
      return;
    }
    const content = readWorkspaceFile(param(req, "id"), path);
    if (content === null) {
      res.status(404).json({ error: "file_not_found", path });
      return;
    }
    res.json({ path, content });
  });

  /**
   * Serves a generated MVP as a static site when it produced one.
   *
   * Read-only and path-guarded. The generated project is never executed here;
   * this only returns files it already wrote.
   */
  app.get("/api/opportunities/:id/preview", (req, res) => {
    const opportunity = getStore().getOpportunity(param(req, "id"));
    if (!opportunity || opportunity.build?.state !== "completed") {
      res.status(404).json({ error: "no_preview", message: "This opportunity has no completed build" });
      return;
    }
    const indexPath = typeof req.query.path === "string" ? req.query.path : "index.html";
    const content = readWorkspaceFile(param(req, "id"), indexPath);
    if (content === null) {
      res.status(404).json({
        error: "not_static",
        message:
          "The generated project has no index.html. It is a Node.js application; inspect its files instead.",
      });
      return;
    }
    res.type("html").send(content);
  });

  // ---------------------------------------------------------------------
  // Activity and streams
  // ---------------------------------------------------------------------

  app.get("/api/activity", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const opportunityId =
      typeof req.query.opportunityId === "string" ? req.query.opportunityId : undefined;
    res.json({
      events: getStore().listActivity(limit, opportunityId),
      activeRuns: listActiveRuns(),
    });
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

  // ---------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------

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

function sanitise(status: Awaited<ReturnType<SwitchHub["status"]>>) {
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

function summarise(opportunities: Opportunity[]) {
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

/** A compact shape for list views, so the list route stays cheap. */
function toListItem(opportunity: Opportunity) {
  return {
    id: opportunity.id,
    state: opportunity.state,
    title: opportunity.brief?.title ?? opportunity.cluster.label,
    problem: opportunity.cluster.problemStatement,
    signalCount: opportunity.cluster.signalCount,
    confidence: opportunity.brief?.confidence ?? null,
    verdicts: opportunity.verdicts.map((v) => ({ juror: v.juror, vote: v.vote, score: v.score })),
    humanVote: opportunity.humanVote?.decision ?? null,
    buildState: opportunity.build?.state ?? null,
    updatedAt: opportunity.updatedAt,
  };
}
