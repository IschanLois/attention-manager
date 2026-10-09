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
  logLevel: LogLevel;
}

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): ReceiverConfig {
  const host = env.RECEIVER_HOST?.trim() || "127.0.0.1";
  const databasePath = env.DATABASE_PATH?.trim() || "./data/attention.db";
  const tokenPath = resolve(cwd, env.INGEST_TOKEN_PATH?.trim() || "./data/ingest-token");
  return {
    host,
    port: intFromEnv("RECEIVER_PORT", 4318, 1, 65535),
    databasePath: databasePath === ":memory:" ? databasePath : resolve(cwd, databasePath),
    tokenPath,
    ingestToken: readIngestToken(tokenPath),
    maxBodyBytes: intFromEnv("MAX_BODY_BYTES", 65_536, 1024, 10_000_000),
    eventHistoryLimit: intFromEnv("EVENT_HISTORY_LIMIT", 50, 1, 10_000),
    staleAfterMs: intFromEnv("STALE_AFTER_MS", 600_000, 1000, 86_400_000),
    dedupeWindowMs: intFromEnv("DEDUPE_WINDOW_MS", 5_000, 0, 3_600_000),
    rateLimit: {
      perSessionPerMinute: intFromEnv("RATE_LIMIT_PER_SESSION", 120, 1, 100_000),
      globalPerMinute: intFromEnv("RATE_LIMIT_GLOBAL", 1200, 1, 1_000_000),
    },
    ollamaUrl: (env.OLLAMA_URL?.trim() || "http://127.0.0.1:11434").replace(/\/+$/, ""),
    ollamaModel: env.OLLAMA_MODEL?.trim() || "qwen2.5:1.5b",
    classifyTimeoutMs: intFromEnv("CLASSIFY_TIMEOUT_MS", 8000, 500, 600_000),
    logLevel: parseLogLevel(env.LOG_LEVEL),
  };
}
