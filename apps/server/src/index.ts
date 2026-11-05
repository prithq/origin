import type { AgentKey, RoomKey } from "@origin/contracts";
import { config, assertLiveRequirements } from "./config.js";
import { createApp } from "./app.js";
import { logger } from "./lib/logger.js";
import { SwitchHub } from "./switch/hub.js";

async function main(): Promise<void> {
  const problems = assertLiveRequirements();
  if (problems.length > 0) {
    for (const p of problems) logger.error(`Configuration: ${p}`);
    logger.error("Refusing to start with an incomplete live configuration.");
    process.exit(1);
  }

  const hub = new SwitchHub({
    onEvent: ({ agentKey, roomKey, payload }) => {
      // The workflow engine subscribes here once it exists. Until then the hub
      // still records that a real SWITCH event arrived, so the connection is
      // observably live rather than merely established.
      logger.debug(
        `SWITCH event from ${payload.sender_name} to ${agentKey} in ${roomKey ?? "unknown room"}`,
      );
    },
  });

  try {
    await hub.start();
  } catch (err) {
    logger.error(`SWITCH startup failed: ${(err as Error).message}`);
    logger.error(
      "Set SWITCH_MODE=offline for development without the bridge. Live mode does not pretend to work.",
    );
    process.exit(1);
  }

  const app = createApp({ hub });
  const server = app.listen(config.PORT, () => {
    logger.info(`Origin API listening on http://localhost:${config.PORT}`);
    logger.info(`LLM mode: ${config.LLM_MODE} (model ${config.DEEPRELAY_MODEL})`);
    logger.info(`SWITCH mode: ${config.SWITCH_MODE}`);
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
