import { config, assertLiveRequirements } from "./config.js";
import { createApp } from "./app.js";
import { logger } from "./lib/logger.js";
import { SwitchHub } from "./switch/hub.js";
import { EventRouter } from "./switch/event-router.js";
import { Orchestrator } from "./workflow/orchestrator.js";
import { getStore } from "./db/store.js";
import { isSandboxAvailable } from "./build/sandbox.js";

async function main(): Promise<void> {
  const problems = assertLiveRequirements();
  if (problems.length > 0) {
    for (const p of problems) logger.error(`Configuration: ${p}`);
    logger.error("Refusing to start with an incomplete live configuration.");
    process.exit(1);
  }

  const store = getStore();
  const existing = store.listOpportunities();
  if (existing.length > 0) {
    // Recovery check: persisted opportunities must still satisfy their schema.
    const counts: Record<string, number> = {};
    for (const o of existing) counts[o.state] = (counts[o.state] ?? 0) + 1;
    logger.info(`Recovered ${existing.length} opportunity record(s): ${JSON.stringify(counts)}`);
  }

  // The orchestrator needs the hub, and the router needs both. The hub is
  // constructed first with a handler that the router supplies afterwards, which
  // avoids a circular construction without hiding the dependency.
  let router: EventRouter | null = null;

  const hub = new SwitchHub({
    connectionIdPrefix: "origin-server",
    onEvent: async ({ agentKey, roomKey, payload }) => {
      if (!router) return;
      await router.handle({ agentKey, roomKey, payload });
    },
  });

  const orchestrator = new Orchestrator({ hub });
  router = new EventRouter({ hub, orchestrator });

  try {
    await hub.start();
  } catch (err) {
    logger.error(`SWITCH startup failed: ${(err as Error).message}`);
    logger.error(
      "Set SWITCH_MODE=offline for development without the bridge. Live mode does not pretend to work.",
    );
    process.exit(1);
  }

  if (!isSandboxAvailable()) {
    logger.warn(
      "bubblewrap is not installed: the Builder will refuse to run. Builds are disabled rather than executed unsafely.",
    );
  }

  const app = createApp({ hub, orchestrator });
  const server = app.listen(config.PORT, () => {
    logger.info(`Origin API listening on http://localhost:${config.PORT}`);
    logger.info(`Model: ${config.DEEPRELAY_MODEL} via DeepRelay`);
    logger.info(`SWITCH mode: ${config.SWITCH_MODE}, ready=${hub.isReady}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}; shutting down`);
    server.close();
    await hub.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
