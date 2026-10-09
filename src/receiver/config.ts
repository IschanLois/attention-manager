import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseLogLevel, type LogLevel } from "../core/logger.ts";

export interface ReceiverConfig {
  host: string;
  port: number;
  databasePath: string;
  tokenPath: string;
  ingestToken: string | null;
  maxBodyBytes: number;
  eventHistoryLimit: number;
  staleAfterMs: number;
  dedupeWindowMs: number;
  rateLimit: { perSessionPerMinute: number; globalPerMinute: number };
  ollamaUrl: string;
  ollamaModel: string;
  classifyTimeoutMs: number;
  retentionMs: number;
  maxSessions: number;
  allowNoToken: boolean;
  captureTaskContext: boolean;
  logLevel: LogLevel;
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

type Env = Record<string, string | undefined>;

let currentEnv: Env = process.env;

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = currentEnv[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function readIngestToken(tokenPath: string): string | null {
  if (process.env.ATTENTION_INGEST_TOKEN) return process.env.ATTENTION_INGEST_TOKEN.trim() || null;
  if (!existsSync(tokenPath)) return null;
  const token = readFileSync(tokenPath, "utf8").trim();
  return token || null;
}

export interface ConfigDefaults {
  port?: number;
  databasePath?: string;
  tokenPath?: string;
  ollamaUrl?: string;
  ollamaModel?: string;
}

export function loadConfig(env: Env = process.env, cwd: string = process.cwd(), defaults: ConfigDefaults = {}): ReceiverConfig {
  currentEnv = env;
  const host = env.RECEIVER_HOST?.trim() || "127.0.0.1";
  const databasePath = env.DATABASE_PATH?.trim() || defaults.databasePath || "./data/attention.db";
  const tokenPath = resolve(cwd, env.INGEST_TOKEN_PATH?.trim() || defaults.tokenPath || "./data/ingest-token");
  return {
    host,
    port: intFromEnv("RECEIVER_PORT", defaults.port ?? 4318, 1, 65535),
    databasePath: databasePath === ":memory:" ? databasePath : resolve(cwd, databasePath),
    tokenPath,
    ingestToken: readIngestToken(tokenPath),
    maxBodyBytes: intFromEnv("MAX_BODY_BYTES", 262_144, 1024, 10_000_000),
    eventHistoryLimit: intFromEnv("EVENT_HISTORY_LIMIT", 50, 1, 10_000),
    staleAfterMs: intFromEnv("STALE_AFTER_MS", 600_000, 1000, 86_400_000),
    dedupeWindowMs: intFromEnv("DEDUPE_WINDOW_MS", 5_000, 0, 3_600_000),
    rateLimit: {
      perSessionPerMinute: intFromEnv("RATE_LIMIT_PER_SESSION", 120, 1, 100_000),
      globalPerMinute: intFromEnv("RATE_LIMIT_GLOBAL", 1200, 1, 1_000_000),
    },
    ollamaUrl: (env.OLLAMA_URL?.trim() || defaults.ollamaUrl || "http://127.0.0.1:11434").replace(/\/+$/, ""),
    ollamaModel: env.OLLAMA_MODEL?.trim() || defaults.ollamaModel || "qwen3:1.7b",
    classifyTimeoutMs: intFromEnv("CLASSIFY_TIMEOUT_MS", 15_000, 500, 600_000),
    retentionMs: intFromEnv("RETENTION_DAYS", 7, 1, 365) * 24 * 60 * 60_000,
    maxSessions: intFromEnv("MAX_SESSIONS", 1000, 10, 100_000),
    allowNoToken: env.ATTENTION_ALLOW_NO_TOKEN === "1",
    captureTaskContext: env.CAPTURE_TASK_CONTEXT !== "0",
    logLevel: parseLogLevel(env.LOG_LEVEL),
  };
}
