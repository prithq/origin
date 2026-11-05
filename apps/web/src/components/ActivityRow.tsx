/** A single structured agent event. Not a chat bubble. */

import type { ActivityEvent } from "@origin/contracts";
import { AlertCircle, CheckCircle2, Circle, Info } from "lucide-react";
import { cx, formatTime } from "./primitives";

const LEVEL_ICON = {
  info: Info,
  success: CheckCircle2,
  warning: AlertCircle,
  error: AlertCircle,
} as const;

const LEVEL_COLOR = {
  info: "text-subtle",
  success: "text-success",
  warning: "text-warning",
  error: "text-danger",
} as const;

export function ActivityRow({
  event,
  compact = false,
}: {
  event: ActivityEvent;
  compact?: boolean;
}) {
  const Icon = LEVEL_ICON[event.level] ?? Circle;
  const color = LEVEL_COLOR[event.level] ?? "text-subtle";

  return (
    <li className={cx("px-3.5", compact ? "py-2.5" : "py-3")}>
      <div className="flex items-start gap-2.5">
        <Icon size={13} className={cx("mt-0.5 shrink-0", color)} strokeWidth={2} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-xs leading-snug text-content">{event.summary}</p>
            <span className="tabular shrink-0 text-2xs text-subtle">
              {formatTime(event.at)}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-subtle">
            <span className="uppercase tracking-wide">{event.phase}</span>
            {event.agentKey ? <span>· {event.agentKey}</span> : null}
            {event.room ? <span>· #{event.room}</span> : null}
            {event.viaSwitch ? (
              <span className="text-accent">· via SWITCH</span>
            ) : null}
          </div>
          {event.detail && !compact ? (
            <p className="mt-1.5 whitespace-pre-wrap break-words text-2xs leading-relaxed text-muted">
              {event.detail.slice(0, 600)}
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );
}
