import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ClassificationSource, EventType, NormalizedEvent, Priority, Session, SessionStatus, StoredEvent } from "../schemas.ts";

export interface StoreOptions {
  path: string;
  eventHistoryLimit: number;
}

export interface Store {
  upsertSession(session: Session): void;
  getSession(sessionId: string): Session | null;
  listSessions(): Session[];
  insertEvent(event: NormalizedEvent): void;
  listEvents(sessionId: string, limit?: number): StoredEvent[];
  countEvents(sessionId: string): number;
  hasRecentEvent(dedupeKey: string, nowMs: number, windowMs: number): boolean;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  label TEXT,
  started_at TEXT,
  last_seen_at TEXT NOT NULL,
  last_event_type TEXT,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  attention_reason TEXT,
  classification_confidence REAL,
  classification_source TEXT NOT NULL,
  classified_at TEXT,
  classification_evidence TEXT NOT NULL DEFAULT '[]',
  classification_error TEXT,
  ended_at TEXT,
  recent_failure_times TEXT NOT NULL DEFAULT '[]',
  pending_permission_tool_use_id TEXT
);
CREATE INDEX IF NOT EXISTS sessions_last_seen ON sessions(last_seen_at);
CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  summary TEXT,
  dedupe_key TEXT
);
CREATE INDEX IF NOT EXISTS session_events_session ON session_events(session_id, id DESC);
CREATE INDEX IF NOT EXISTS session_events_dedupe ON session_events(dedupe_key, received_at);
`;

interface SessionRow {
  session_id: string;
  label: string | null;
  started_at: string | null;
  last_seen_at: string;
  last_event_type: string | null;
  status: string;
  priority: string;
  attention_reason: string | null;
  classification_confidence: number | null;
  classification_source: string;
  classified_at: string | null;
  classification_evidence: string;
  classification_error: string | null;
  ended_at: string | null;
  recent_failure_times: string;
  pending_permission_tool_use_id: string | null;
}

interface EventRow {
  id: number;
  session_id: string;
  event_type: string;
  received_at: string;
  summary: string | null;
  dedupe_key: string | null;
}

function parseStringArray(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function rowToSession(row: SessionRow): Session {
  return {
    sessionId: row.session_id,
    label: row.label,
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    lastEventType: row.last_event_type as EventType | null,
    status: row.status as SessionStatus,
    priority: row.priority as Priority,
    attentionReason: row.attention_reason,
    classificationConfidence: row.classification_confidence,
    classificationSource: row.classification_source as ClassificationSource,
    classifiedAt: row.classified_at,
    classificationEvidence: parseStringArray(row.classification_evidence),
    classificationError: row.classification_error,
    endedAt: row.ended_at,
    recentFailureTimes: parseStringArray(row.recent_failure_times),
    pendingPermissionToolUseId: row.pending_permission_tool_use_id,
  };
}

function rowToEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    eventType: row.event_type as EventType,
    receivedAt: row.received_at,
    summary: row.summary,
    dedupeKey: row.dedupe_key,
  };
}

export function openStore(options: StoreOptions): Store {
  if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
  const db = new DatabaseSync(options.path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);

  const upsert = db.prepare(`
    INSERT INTO sessions (
      session_id, label, started_at, last_seen_at, last_event_type, status, priority, attention_reason,
      classification_confidence, classification_source, classified_at, classification_evidence,
      classification_error, ended_at, recent_failure_times, pending_permission_tool_use_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      label = excluded.label, started_at = excluded.started_at, last_seen_at = excluded.last_seen_at,
      last_event_type = excluded.last_event_type, status = excluded.status, priority = excluded.priority,
      attention_reason = excluded.attention_reason, classification_confidence = excluded.classification_confidence,
      classification_source = excluded.classification_source, classified_at = excluded.classified_at,
      classification_evidence = excluded.classification_evidence, classification_error = excluded.classification_error,
      ended_at = excluded.ended_at, recent_failure_times = excluded.recent_failure_times,
      pending_permission_tool_use_id = excluded.pending_permission_tool_use_id
  `);
  const selectOne = db.prepare("SELECT * FROM sessions WHERE session_id = ?");
  const selectAll = db.prepare("SELECT * FROM sessions ORDER BY last_seen_at DESC");
  const insertEvent = db.prepare(
    "INSERT INTO session_events (session_id, event_type, received_at, summary, dedupe_key) VALUES (?, ?, ?, ?, ?)",
  );
  const pruneEvents = db.prepare(`
    DELETE FROM session_events WHERE session_id = ? AND id NOT IN (
      SELECT id FROM session_events WHERE session_id = ? ORDER BY id DESC LIMIT ?
    )
  `);
  const selectEvents = db.prepare("SELECT * FROM session_events WHERE session_id = ? ORDER BY id DESC LIMIT ?");
  const countEvents = db.prepare("SELECT COUNT(*) AS n FROM session_events WHERE session_id = ?");
  const recentByKey = db.prepare("SELECT 1 AS hit FROM session_events WHERE dedupe_key = ? AND received_at >= ? LIMIT 1");

  return {
    upsertSession(s) {
      upsert.run(
        s.sessionId, s.label, s.startedAt, s.lastSeenAt, s.lastEventType, s.status, s.priority, s.attentionReason,
        s.classificationConfidence, s.classificationSource, s.classifiedAt, JSON.stringify(s.classificationEvidence),
        s.classificationError, s.endedAt, JSON.stringify(s.recentFailureTimes), s.pendingPermissionToolUseId,
      );
    },
    getSession(sessionId) {
      const row = selectOne.get(sessionId) as unknown as SessionRow | undefined;
      return row ? rowToSession(row) : null;
    },
    listSessions() {
      return (selectAll.all() as unknown as SessionRow[]).map(rowToSession);
    },
    insertEvent(event) {
      insertEvent.run(event.sessionId, event.type, event.receivedAt, event.summary, event.dedupeKey);
      pruneEvents.run(event.sessionId, event.sessionId, options.eventHistoryLimit);
    },
    listEvents(sessionId, limit = options.eventHistoryLimit) {
      return (selectEvents.all(sessionId, limit) as unknown as EventRow[]).map(rowToEvent);
    },
    countEvents(sessionId) {
      return Number((countEvents.get(sessionId) as { n: number }).n);
    },
    hasRecentEvent(dedupeKey, nowMs, windowMs) {
      return recentByKey.get(dedupeKey, new Date(nowMs - windowMs).toISOString()) !== undefined;
    },
    close() {
      db.close();
    },
  };
}
