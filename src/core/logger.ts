export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Logger {
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = "info"): LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value ?? "") ? (value as LogLevel) : fallback;
}

export function createLogger(level: LogLevel, sink: (line: string) => void = (line) => process.stderr.write(line + "\n")): Logger {
  const threshold = LOG_LEVELS.indexOf(level);
  const emit = (lvl: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (LOG_LEVELS.indexOf(lvl) > threshold) return;
    const suffix = fields && Object.keys(fields).length > 0 ? " " + JSON.stringify(fields) : "";
    sink(`${new Date().toISOString()} ${lvl.toUpperCase()} ${message}${suffix}`);
  };
  return {
    error: (m, f) => emit("error", m, f),
    warn: (m, f) => emit("warn", m, f),
    info: (m, f) => emit("info", m, f),
    debug: (m, f) => emit("debug", m, f),
  };
}
