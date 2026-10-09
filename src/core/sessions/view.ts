import type { Session, StoredEvent } from "../schemas.ts";
import { isStale, sortSessions } from "./state-machine.ts";

export interface SessionView extends Session {
  stale: boolean;
}

export interface SessionsSnapshot {
  sessions: SessionView[];
  now: string;
  staleAfterMs: number;
}

export interface SessionDetail {
  session: SessionView;
  events: StoredEvent[];
  now: string;
}

export function toView(session: Session, nowMs: number, staleAfterMs: number): SessionView {
  return { ...session, stale: isStale(session, nowMs, staleAfterMs) };
}

export function toSnapshot(sessions: Session[], nowMs: number, staleAfterMs: number): SessionsSnapshot {
  return {
    sessions: sortSessions(sessions, nowMs, staleAfterMs).map((s) => toView(s, nowMs, staleAfterMs)),
    now: new Date(nowMs).toISOString(),
    staleAfterMs,
  };
}
