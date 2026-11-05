/**
 * The application shell: a fixed sidebar, a slim top bar and the page area.
 *
 * Navigation is grouped by workflow phase rather than by feature, so the shape
 * of the sidebar tells you how Origin works: discover, decide, build.
 */

import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Activity,
  Boxes,
  Hammer,
  LayoutDashboard,
  Moon,
  Radio,
  Sun,
  Users,
} from "lucide-react";
import { api, type HealthResponse } from "../lib/api";
import { useTheme } from "../lib/theme";
import { useEventStream } from "../lib/useEventStream";
import { cx, StatusDot } from "../components/primitives";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  end?: boolean;
}

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Studio",
    items: [
      { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
      { to: "/discovery", label: "Discovery", icon: Radio },
      { to: "/opportunities", label: "Opportunities", icon: Boxes },
    ],
  },
  {
    label: "Council",
    items: [
      { to: "/council", label: "Startup Council", icon: Users },
      { to: "/activity", label: "Agent Activity", icon: Activity },
    ],
  },
  {
    label: "Build",
    items: [{ to: "/build", label: "Build Studio", icon: Hammer }],
  },
];

export function AppShell() {
  const { theme, toggle } = useTheme();
  const location = useLocation();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [streamStatus, setStreamStatus] = useState<"connecting" | "open" | "closed">(
    "connecting",
  );

  const { status } = useEventStream({
    onActivity: () => {
      // Pages subscribe for detail; the shell only needs liveness.
    },
  });

  useEffect(() => {
    setStreamStatus(status);
  }, [status]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api
        .health()
        .then((h) => {
          if (!cancelled) setHealth(h);
        })
        .catch(() => {
          if (!cancelled) setHealth(null);
        });
    };
    load();
    const interval = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [location.pathname]);

  const liveAgents =
    health && health.liveSwitch ? "live" : health ? "offline" : "unknown";

  return (
    <div className="flex min-h-screen bg-bg">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-56 shrink-0 flex-col border-r border-border bg-bg-subtle lg:flex">
        <div className="flex h-14 items-center gap-2.5 border-b border-border px-4">
          <div className="flex h-6 w-6 items-center justify-center rounded border border-accent/40 bg-accent/10">
            <span className="text-[11px] font-semibold text-accent">O</span>
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight text-content">
              Origin
            </p>
            <p className="truncate text-2xs text-subtle">Venture studio</p>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-4">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="mb-5">
              <p className="mb-1.5 px-2 text-2xs font-medium uppercase tracking-wider text-subtle">
                {group.label}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        end={item.end}
                        className={({ isActive }) =>
                          cx(
                            "flex items-center gap-2.5 rounded px-2 py-1.5 text-xs transition-colors",
                            isActive
                              ? "bg-surface font-medium text-content"
                              : "text-muted hover:bg-surface hover:text-content",
                          )
                        }
                      >
                        <Icon size={14} strokeWidth={1.75} />
                        {item.label}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-border px-3 py-3">
          <div className="space-y-1.5 text-2xs">
            <StatusLine
              label="SWITCH"
              value={liveAgents === "live" ? "connected" : liveAgents}
              tone={liveAgents === "live" ? "success" : "danger"}
            />
            <StatusLine
              label="Stream"
              value={streamStatus === "open" ? "live" : streamStatus}
              tone={streamStatus === "open" ? "success" : "warning"}
            />
            <StatusLine
              label="Model"
              value={health?.modelConfigured ? "live" : "missing"}
              tone={health?.modelConfigured ? "success" : "danger"}
            />
            <StatusLine
              label="Sandbox"
              value={health?.sandboxAvailable ? "ready" : "unavailable"}
              tone={health?.sandboxAvailable ? "success" : "danger"}
            />
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col lg:pl-56">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-4 border-b border-border bg-bg/85 px-4 backdrop-blur sm:px-6">
          <div className="flex items-center gap-3 lg:hidden">
            <div className="flex h-6 w-6 items-center justify-center rounded border border-accent/40 bg-accent/10">
              <span className="text-[11px] font-semibold text-accent">O</span>
            </div>
            <span className="text-sm font-semibold tracking-tight">Origin</span>
          </div>

          <div className="hidden items-center gap-2 lg:flex">
            {health?.modelConfigured && health?.liveSwitch ? (
              <span className="text-2xs text-subtle">
                Live agents, real evidence, real builds
              </span>
            ) : (
              <span className="text-2xs text-warning">
                {!health?.modelConfigured
                  ? "Model credential is missing — agent calls will fail"
                  : "SWITCH offline mode — agent collaboration is mocked"}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <a
              href="/opportunities"
              className="hidden rounded px-2 py-1 text-2xs text-muted transition-colors hover:bg-surface hover:text-content sm:block"
            >
              Opportunities
            </a>
            <button
              type="button"
              onClick={toggle}
              title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              className="flex h-8 w-8 items-center justify-center rounded border border-border text-muted transition-colors hover:bg-surface hover:text-content"
            >
              {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function StatusLine({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "success" | "warning" | "danger" | "neutral";
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-subtle">{label}</span>
      <span className="flex items-center gap-1.5 text-muted">
        <StatusDot tone={tone} />
        <span className="tabular">{value}</span>
      </span>
    </div>
  );
}
