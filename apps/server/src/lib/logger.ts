type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const configured = (process.env.LOG_LEVEL as Level | undefined) ?? "info";
const threshold = LEVEL_ORDER[configured] ?? LEVEL_ORDER.info;

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const stamp = new Date().toISOString();
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} ${message}`;
  const extra = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  if (level === "error" || level === "warn") {
    console.error(line + extra);
  } else {
    console.log(line + extra);
  }
}

export const logger = {
  debug: (m: string, meta?: Record<string, unknown>) => emit("debug", m, meta),
  info: (m: string, meta?: Record<string, unknown>) => emit("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => emit("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => emit("error", m, meta),
};
