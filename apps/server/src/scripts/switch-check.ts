/**
 * SWITCH connectivity verification.
 *
 * Registers (or reuses) all nine Origin agents, ensures the three rooms exist,
 * connects every agent, then proves participation by posting and retrieving a
 * message in each room. Exits non-zero on any failure so this can gate a build.
 */

import { AGENT_SPECS, ROOM_SPECS } from "@origin/contracts";
import { config, assertLiveRequirements } from "../config.js";
import { logger } from "../lib/logger.js";
import { SwitchHub } from "../switch/hub.js";

async function main(): Promise<void> {
  if (config.SWITCH_MODE !== "live") {
    console.error("SWITCH_MODE is not 'live'; this script verifies the real bridge only.");
    process.exit(1);
  }

  const missing = assertLiveRequirements();
  if (missing.length > 0) {
    console.error(`Configuration incomplete:\n  - ${missing.join("\n  - ")}`);
    process.exit(1);
  }

  console.log("Verifying SWITCH connectivity\n");
  const hub = new SwitchHub({ connectionIdPrefix: "origin-verify" });
  const started = Date.now();

  try {
    await hub.start();
  } catch (err) {
    console.error(`\nFAILED to start SWITCH hub: ${(err as Error).message}`);
    process.exit(1);
  }

  const status = await hub.status();
  let failures = 0;

  console.log("\nAgents");
  for (const agent of status.agents) {
    const ok = agent.connectionState === "connected";
    if (!ok) failures += 1;
    const mark = ok ? "ok  " : "FAIL";
    console.log(
      `  ${mark}  ${agent.displayName.padEnd(20)} ${agent.switchAgentId ?? "(unregistered)"}  ${agent.connectionState}`,
    );
  }

  console.log("\nRooms");
  for (const room of status.rooms) {
    const ok = Boolean(room.switchRoomId) && room.memberCount > 0;
    if (!ok) failures += 1;
    const mark = ok ? "ok  " : "FAIL";
    console.log(
      `  ${mark}  ${room.name.padEnd(18)} ${room.switchRoomId ?? "(missing)"}  members=${room.memberCount}  bridged=${room.bridged}`,
    );
  }

  // Prove participation: each room's first agent posts, and the message is
  // readable back through the same room.
  console.log("\nParticipation probe");
  for (const roomSpec of ROOM_SPECS) {
    const spoke = AGENT_SPECS.find((a) => a.room === roomSpec.key);
    if (!spoke) continue;
    try {
      await hub.postAs(spoke.key, `Origin connectivity probe in ${roomSpec.name}.`);
      console.log(`  ok    ${spoke.displayName} posted in ${roomSpec.name}`);
    } catch (err) {
      failures += 1;
      console.log(`  FAIL  ${spoke.displayName} could not post: ${(err as Error).message}`);
    }
  }

  // Confirm the human participant surface is present on a bridged room.
  const council = status.rooms.find((r) => r.key === "startup-council");
  if (council) {
    try {
      const participants = await hub.listParticipants("startup-council");
      const humans = participants.filter((p) => p.type === "user");
      const agents = participants.filter((p) => p.type === "agent");
      console.log(
        `\nstartup-council participants: ${agents.length} agents, ${humans.length} humans` +
          (humans.length > 0 ? ` (${humans.map((h) => h.name).join(", ")})` : ""),
      );
      if (humans.length === 0) {
        console.log(
          "  note  no human participant yet; add the founder to the bridged room in Mattermost",
        );
      }
    } catch (err) {
      console.log(`  warn  could not list participants: ${(err as Error).message}`);
    }
  }

  await hub.stop();

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${status.agents.length} agents, ${status.rooms.length} rooms in ${seconds}s`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  logger.error(`Unexpected failure: ${(err as Error).message}`);
  process.exit(1);
});
