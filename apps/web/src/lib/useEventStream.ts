/**
 * Live event stream.
 *
 * The dashboard should reflect work as it happens. SSE is used rather than
 * polling so the interface updates when an agent finishes something, not on a
 * fixed delay.
 *
 * Reconnection is explicit: EventSource retries on its own, but a component
 * also needs to know the stream is down so it can show an honest state rather
 * than silently going stale.
 */

import { useEffect, useRef, useState } from "react";
import type { ActivityEvent, Opportunity } from "@origin/contracts";

export type StreamStatus = "connecting" | "open" | "closed";

export interface StreamHandlers {
  onActivity?: (event: ActivityEvent) => void;
  onOpportunity?: (opportunity: Opportunity) => void;
  onState?: (payload: { opportunityId: string; state: string }) => void;
}

export function useEventStream(handlers: StreamHandlers): {
  status: StreamStatus;
  lastEventAt: number | null;
} {
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const source = new EventSource("/api/events");

    source.onopen = () => setStatus("open");
    source.onerror = () => setStatus("closed");

    const handle = (type: string, fn: (data: unknown) => void) => {
      source.addEventListener(type, (event) => {
        try {
          fn(JSON.parse((event as MessageEvent).data));
          setLastEventAt(Date.now());
        } catch {
          /* a malformed frame must not tear down the stream */
        }
      });
    };

    handle("activity", (data) => handlersRef.current.onActivity?.(data as ActivityEvent));
    handle("opportunity", (data) =>
      handlersRef.current.onOpportunity?.(data as Opportunity),
    );
    handle("state", (data) =>
      handlersRef.current.onState?.(data as { opportunityId: string; state: string }),
    );

    return () => source.close();
  }, []);

  return { status, lastEventAt };
}
