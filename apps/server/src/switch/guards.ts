/**
 * Guards against agent loops and duplicate event processing.
 *
 * Two distinct problems are handled here, because they have different causes:
 *
 *  - Duplicate delivery. A reconnect or replay can redeliver the same SWITCH
 *    message. Processing it twice would double-post, double-vote or double
 *    build. Messages are deduplicated by SWITCH message id.
 *
 *  - Runaway conversation. Agents addressing each other can ping-pong
 *    indefinitely. Every opportunity has a hop budget for agent-to-agent
 *    handoffs, and exhausting it stops the exchange instead of letting it run.
 *
 * Both are in-memory by design: they describe the life of one process. Persisted
 * state is what survives a restart, and a replayed message after a restart is
 * correctly treated as new because its work may genuinely not have happened.
 */

import { logger } from "../lib/logger.js";

/** Seen SWITCH message ids, bounded so a long-running process cannot leak. */
const SEEN_LIMIT = 5_000;
const seenOrder: string[] = [];
const seen = new Set<string>();

/** Hop counts per opportunity. */
const hops = new Map<string, number>();

/** The maximum agent-to-agent handoffs for one opportunity. */
export const MAX_HOPS = 12;

/**
 * Returns true when the message has not been seen before.
 * Recording and testing is a single operation so callers cannot forget one half.
 */
export function claimMessage(messageId: string): boolean {
  if (!messageId) return false;
  if (seen.has(messageId)) {
    logger.warn(`Ignoring duplicate SWITCH message ${messageId}`);
    return false;
  }
  seen.add(messageId);
  seenOrder.push(messageId);
  if (seenOrder.length > SEEN_LIMIT) {
    const evicted = seenOrder.shift();
    if (evicted) seen.delete(evicted);
  }
  return true;
}

export class HopBudgetExceeded extends Error {
  constructor(opportunityId: string, limit: number) {
    super(
      `Agent handoff budget exhausted for ${opportunityId} after ${limit} hops. ` +
        "Stopping the exchange rather than allowing an agent-to-agent loop.",
    );
    this.name = "HopBudgetExceeded";
  }
}

/** Records a handoff and throws once the budget is spent. */
export function recordHop(opportunityId: string, fromAgent: string, toAgent: string): number {
  const current = (hops.get(opportunityId) ?? 0) + 1;
  hops.set(opportunityId, current);
  logger.debug(`Handoff ${fromAgent} -> ${toAgent} (hop ${current}/${MAX_HOPS})`);
  if (current > MAX_HOPS) {
    throw new HopBudgetExceeded(opportunityId, MAX_HOPS);
  }
  return current;
}

export function hopCount(opportunityId: string): number {
  return hops.get(opportunityId) ?? 0;
}

export function resetHops(opportunityId: string): void {
  hops.delete(opportunityId);
}

/** Test seam: clears all guard state. */
export function resetGuards(): void {
  seen.clear();
  seenOrder.length = 0;
  hops.clear();
}
