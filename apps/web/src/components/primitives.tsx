/**
 * Shared visual primitives.
 *
 * These exist so the whole application has one definition of a button, a badge,
 * a status dot and a loading state. Pages compose them instead of restyling.
 */

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import type { WorkflowState } from "@origin/contracts";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

export function Button({
  children,
  variant = "secondary",
  size = "md",
  loading = false,
  disabled,
  onClick,
  type = "button",
  title,
  className,
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  title?: string;
  className?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45";
  const sizes = size === "sm" ? "h-8 px-3 text-xs" : "h-9 px-4 text-sm";
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-accent text-[hsl(var(--accent-fg))] hover:bg-accent/90",
    secondary:
      "border border-border bg-surface text-content hover:bg-surface-hover hover:border-border-strong",
    ghost: "text-muted hover:bg-surface-hover hover:text-content",
    danger: "border border-danger/40 text-danger hover:bg-danger/10",
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
      className={cx(base, sizes, variants[variant], className)}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : null}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  const tones: Record<BadgeTone, string> = {
    neutral: "border-border bg-surface-hover text-muted",
    accent: "border-accent/30 bg-accent/10 text-accent",
    success: "border-success/30 bg-success/10 text-success",
    warning: "border-warning/30 bg-warning/10 text-warning",
    danger: "border-danger/30 bg-danger/10 text-danger",
  };

  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Status dot
// ---------------------------------------------------------------------------

export function StatusDot({
  tone = "neutral",
  pulse = false,
  className,
}: {
  tone?: "neutral" | "success" | "warning" | "danger" | "accent";
  pulse?: boolean;
  className?: string;
}) {
  const colors = {
    neutral: "bg-subtle",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    accent: "bg-accent",
  } as const;

  return (
    <span
      className={cx(
        "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
        colors[tone],
        pulse && "pulse-dot",
        className,
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Workflow state
// ---------------------------------------------------------------------------

const STATE_TONE: Record<WorkflowState, BadgeTone> = {
  IDLE: "neutral",
  DISCOVERING: "accent",
  RESEARCHING: "accent",
  JURY_REVIEW: "accent",
  AWAITING_HUMAN_VOTE: "warning",
  APPROVED: "success",
  BUILDING: "accent",
  TESTING: "accent",
  COMPLETED: "success",
  REJECTED: "danger",
  FAILED: "danger",
};

const STATE_LABEL: Record<WorkflowState, string> = {
  IDLE: "Idle",
  DISCOVERING: "Discovering",
  RESEARCHING: "Researching",
  JURY_REVIEW: "Jury review",
  AWAITING_HUMAN_VOTE: "Awaiting vote",
  APPROVED: "Approved",
  BUILDING: "Building",
  TESTING: "Testing",
  COMPLETED: "Completed",
  REJECTED: "Rejected",
  FAILED: "Failed",
};

export function stateLabel(state: WorkflowState): string {
  return STATE_LABEL[state] ?? state;
}

export function StateBadge({ state }: { state: WorkflowState }) {
  const active =
    state === "DISCOVERING" ||
    state === "RESEARCHING" ||
    state === "JURY_REVIEW" ||
    state === "BUILDING" ||
    state === "TESTING";

  return (
    <Badge tone={STATE_TONE[state] ?? "neutral"}>
      {active ? <StatusDot tone="accent" pulse /> : null}
      {stateLabel(state)}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight text-content">{title}</h2>
        {description ? (
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded border border-dashed border-border px-6 py-14 text-center">
      {icon ? <div className="mb-3 text-subtle">{icon}</div> : null}
      <p className="text-sm font-medium text-content">{title}</p>
      {description ? (
        <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded border border-danger/30 bg-danger/5 px-4 py-3">
      <p className="text-xs font-medium text-danger">Something went wrong</p>
      <p className="mt-1 text-xs leading-relaxed text-muted">{message}</p>
      {onRetry ? (
        <div className="mt-2.5">
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton", className)} />;
}

export function ScoreBar({ score, label }: { score: number; label?: string }) {
  // Confidence is not a pass/fail grade. Early research legitimately scores low,
  // so the bar uses a neutral accent through the middle and only turns
  // warning-coloured near zero, where it signals genuinely missing evidence.
  const tone = score >= 60 ? "bg-success" : score >= 30 ? "bg-accent" : "bg-warning";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-16 overflow-hidden rounded-full bg-surface-hover">
        <div
          className={cx("h-full rounded-full", tone)}
          style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
        />
      </div>
      <span className="tabular text-xs text-muted">{score}</span>
      {label ? <span className="text-2xs text-subtle">{label}</span> : null}
    </div>
  );
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
