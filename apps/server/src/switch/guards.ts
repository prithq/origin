/**
 * Duplicate event suppression.
 *
 * A reconnect or replay can redeliver the same SWITCH message. Processing it
 * twice would double-post, double-vote or double-build, so each message is
 * claimed once by its SWITCH id.
 *
 * This is in-memory by design: it describes the life of one process, while the
 * persisted workflow state is what survives a restart. A message replayed after
 * a restart is correctly treated as new, because its work may genuinely not have
 * happened.
 */

import { logger } from "../lib/logger.js";

/** Seen SWITCH message ids, bounded so a long-running process cannot leak. */
const SEEN_LIMIT = 5_000;
const seenOrder: string[] = [];
const seen = new Set<string>();

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

/** Test seam: clears all guard state. */
export function resetGuards(): void {
  seen.clear();
  seenOrder.length = 0;
}
