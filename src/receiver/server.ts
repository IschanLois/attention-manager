import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ClassifierPort, ModelHealth } from "../core/classifier/types.ts";
import { createLogger, type Logger, type LogLevel } from "../core/logger.ts";
import { openStore, type Store } from "../core/persistence/store.ts";
import { SESSION_ID_PATTERN, type Session } from "../core/schemas.ts";
import { toSnapshot, toView, type SessionDetail } from "../core/sessions/view.ts";
import { IngestPipeline } from "./pipeline.ts";
import { perMinuteLimiter, type TokenBucketLimiter } from "./rate-limit.ts";
import { SseHub } from "./sse.ts";

export interface ReceiverOptions {
  host: string;
  port: number;
  databasePath: string;
  ingestToken: string | null;
  maxBodyBytes: number;
  eventHistoryLimit: number;
  staleAfterMs: number;
  dedupeWindowMs: number;
  rateLimit: { perSessionPerMinute: number; globalPerMinute: number };
  classifier: ClassifierPort;
  logLevel: LogLevel;
  logger?: Logger;
  version?: string;
}

export interface Receiver {
  port: number;
  host: string;
  close(): Promise<void>;
}

export interface HealthReport {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
  receiver: { host: string; port: number; sseClients: number };
  sqlite: { ok: boolean; path: string; error: string | null };
  model: ModelHealth;
  lastEventAt: string | null;
  lastClassificationError: { message: string; at: string } | null;
  sessionCount: number;
}

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const ALLOWED_ORIGIN_HOSTS = ALLOWED_HOSTS;
const SESSION_ROUTE = /^\/api\/sessions\/([^/]+)$/;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function hostIsLoopback(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, "");
  return ALLOWED_HOSTS.has(host);
}

function originIsLoopback(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return ALLOWED_ORIGIN_HOSTS.has(url.hostname) || ALLOWED_ORIGIN_HOSTS.has(`[${url.hostname}]`);
  } catch {
    return false;
  }
}

function tokenMatches(expected: string, provided: string | string[] | undefined): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > maxBytes) return reject(new HttpError(413, "body too large"));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (err) => reject(err));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

export async function createReceiver(options: ReceiverOptions): Promise<Receiver> {
  const logger = options.logger ?? createLogger(options.logLevel);
  const startedAt = Date.now();
  const version = options.version ?? "0.1.0";

  let store: Store;
  let sqliteError: string | null = null;
  try {
    store = openStore({ path: options.databasePath, eventHistoryLimit: options.eventHistoryLimit });
  } catch (error) {
    sqliteError = error instanceof Error ? error.message.slice(0, 200) : "failed to open database";
    logger.error("sqlite unavailable, falling back to in-memory store", { error: sqliteError });
    store = openStore({ path: ":memory:", eventHistoryLimit: options.eventHistoryLimit });
  }

  const hub = new SseHub();
  let lastEventAt: string | null = null;
  let lastClassificationError: HealthReport["lastClassificationError"] = null;
  const sessionLimiter: TokenBucketLimiter = perMinuteLimiter(options.rateLimit.perSessionPerMinute);
  const globalLimiter: TokenBucketLimiter = perMinuteLimiter(options.rateLimit.globalPerMinute);

  const pipeline = new IngestPipeline({
    store,
    classifier: options.classifier,
    logger,
    dedupeWindowMs: options.dedupeWindowMs,
    onSessionChanged: (session: Session) => {
      hub.broadcast("session", toView(session, Date.now(), options.staleAfterMs));
    },
    onClassificationError: (message) => {
      lastClassificationError = { message, at: new Date().toISOString() };
    },
  });

  async function health(): Promise<HealthReport> {
    const model = await options.classifier.health();
    return {
      ok: true,
      version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      receiver: { host: options.host, port: (server.address() as AddressInfo).port, sseClients: hub.size },
      sqlite: { ok: sqliteError === null, path: options.databasePath, error: sqliteError },
      model,
      lastEventAt,
      lastClassificationError,
      sessionCount: pipeline.listSessions().length,
    };
  }

  async function handleIngest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (options.ingestToken && !tokenMatches(options.ingestToken, req.headers["x-attention-token"])) {
      throw new HttpError(401, "missing or invalid ingest token");
    }
    const contentType = String(req.headers["content-type"] ?? "");
    if (!/^application\/json\b/i.test(contentType)) throw new HttpError(415, "expected application/json");
    const nowMs = Date.now();
    if (!globalLimiter.take("global", nowMs)) throw new HttpError(429, "too many events");

    const text = await readBody(req, options.maxBodyBytes);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HttpError(400, "malformed JSON");
    }
    const sessionId = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { session_id?: unknown }).session_id : undefined;
    if (typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId) && !sessionLimiter.take(sessionId, nowMs)) {
      throw new HttpError(429, "too many events for session");
    }

    const result = pipeline.ingest(raw);
    switch (result.status) {
      case "accepted":
        lastEventAt = result.session.lastSeenAt;
        logger.debug("event accepted", { sessionId: result.session.sessionId, type: result.session.lastEventType });
        return sendJson(res, 202, { accepted: true });
      case "ignored":
        return sendJson(res, 200, { accepted: false, reason: result.reason });
      case "rejected":
        throw new HttpError(400, result.reason);
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostIsLoopback(req.headers.host)) throw new HttpError(403, "host not allowed");
    if (!originIsLoopback(req.headers.origin)) throw new HttpError(403, "origin not allowed");
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    if (url.pathname === "/api/events" && method === "POST") return handleIngest(req, res);
    if (url.pathname === "/api/health" && method === "GET") return sendJson(res, 200, await health());
    if (url.pathname === "/api/sessions" && method === "GET") {
      return sendJson(res, 200, toSnapshot(pipeline.listSessions(), Date.now(), options.staleAfterMs));
    }
    const match = SESSION_ROUTE.exec(url.pathname);
    if (match && method === "GET") {
      const id = decodeURIComponent(match[1]!);
      if (!SESSION_ID_PATTERN.test(id)) throw new HttpError(400, "invalid session id");
      const session = pipeline.getSession(id);
      if (!session) throw new HttpError(404, "session not found");
      const now = Date.now();
      const detail: SessionDetail = {
        session: toView(session, now, options.staleAfterMs),
        events: store.listEvents(id),
        now: new Date(now).toISOString(),
      };
      return sendJson(res, 200, detail);
    }
    if (url.pathname === "/api/stream" && method === "GET") {
      const now = Date.now();
      hub.add(res, [
        { event: "snapshot", data: toSnapshot(pipeline.listSessions(), now, options.staleAfterMs) },
        { event: "health", data: await health() },
      ]);
      return;
    }
    throw new HttpError(404, "not found");
  }

  const server: Server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : "internal error";
      if (status === 500) logger.error("request failed", { error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.end();
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 65_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  logger.info("receiver listening", { host: options.host, port: address.port, database: options.databasePath });

  return {
    port: address.port,
    host: options.host,
    async close() {
      hub.closeAll();
      await pipeline.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      store.close();
    },
  };
}
