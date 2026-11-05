/**
 * Server-sent events fan-out.
 *
 * The dashboard reflects real work as it happens. Polling would work but SSE
 * gives the demo an honest "live" feel without adding a websocket layer for
 * the browser.
 */

import type { Response } from "express";
import type { ActivityEvent, Opportunity, WorkflowState } from "@origin/contracts";
import { logger } from "./logger.js";

export type StreamEvent =
  | { type: "activity"; data: ActivityEvent }
  | { type: "opportunity"; data: Opportunity }
  | { type: "state"; data: { opportunityId: string; state: WorkflowState } }
  | { type: "switch"; data: { agentKey: string; status: string } };

const clients = new Set<Response>();

export function addStreamClient(res: Response): void {
  clients.add(res);
  res.on("close", () => {
    clients.delete(res);
  });
}

export function broadcast(event: StreamEvent): void {
  const frame = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(frame);
    } catch (err) {
      logger.debug(`Dropping SSE client: ${(err as Error).message}`);
      clients.delete(client);
    }
  }
}

export function streamClientCount(): number {
  return clients.size;
}

export function heartbeat(): void {
  for (const client of clients) {
    try {
      client.write(": ping\n\n");
    } catch {
      clients.delete(client);
    }
  }
}
