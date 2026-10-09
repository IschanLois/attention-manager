import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ConnectionState, HealthReport, SessionsSnapshot, SessionView } from "../types";

export interface Announcement {
  id: number;
  text: string;
}

export interface StreamState {
  sessions: SessionView[];
  staleAfterMs: number;
  health: HealthReport | null;
  connection: ConnectionState;
  retryAt: number | null;
  failures: number;
  updatedAt: Record<string, number>;
  announcement: Announcement | null;
}

type Action =
  | { type: "snapshot"; snapshot: SessionsSnapshot }
  | { type: "session"; session: SessionView; at: number }
  | { type: "removed"; sessionId: string }
  | { type: "health"; health: HealthReport }
  | { type: "error"; retryAt: number }
  | { type: "clear-announcement"; id: number };

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const OFFLINE_AFTER_FAILURES = 3;
const HEALTH_POLL_MS = 60_000;
const ANNOUNCEMENT_TTL_MS = 6_000;

function alertTransition(previous: SessionView | undefined, next: SessionView): string | null {
  const wasAlerting = previous?.status === "needs_attention" || previous?.status === "error";
  const isAlerting = next.status === "needs_attention" || next.status === "error";
  if (!isAlerting || wasAlerting) return null;
  const name = next.label ?? `session …${next.sessionId.slice(-4)}`;
  const what = next.status === "error" ? "reported an error" : "now needs attention";
  return next.attentionReason ? `Session ${name} ${what}: ${next.attentionReason}` : `Session ${name} ${what}`;
}

let announcementSeq = 0;

function reducer(state: StreamState, action: Action): StreamState {
  switch (action.type) {
    case "snapshot":
      return {
        ...state,
        sessions: action.snapshot.sessions,
        staleAfterMs: action.snapshot.staleAfterMs,
        connection: "live",
        retryAt: null,
        failures: 0,
      };
    case "session": {
      const previous = state.sessions.find((s) => s.sessionId === action.session.sessionId);
      const sessions = previous
        ? state.sessions.map((s) => (s.sessionId === action.session.sessionId ? action.session : s))
        : [...state.sessions, action.session];
      const text = alertTransition(previous, action.session);
      return {
        ...state,
        sessions,
        updatedAt: { ...state.updatedAt, [action.session.sessionId]: action.at },
        announcement: text ? { id: ++announcementSeq, text } : state.announcement,
      };
    }
    case "removed":
      return { ...state, sessions: state.sessions.filter((s) => s.sessionId !== action.sessionId) };
    case "health":
      return { ...state, health: action.health };
    case "error": {
      const failures = state.failures + 1;
      return { ...state, failures, retryAt: action.retryAt, connection: failures >= OFFLINE_AFTER_FAILURES ? "offline" : "reconnecting" };
    }
    case "clear-announcement":
      return state.announcement?.id === action.id ? { ...state, announcement: null } : state;
  }
}

function parseFrame<T>(event: Event): T | null {
  try {
    return JSON.parse((event as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
}

export interface UseSessionStreamOptions {
  initialSnapshot: SessionsSnapshot | null;
  initialHealth: HealthReport | null;
}

export function useSessionStream({ initialSnapshot, initialHealth }: UseSessionStreamOptions) {
  const [state, dispatch] = useReducer(reducer, undefined, (): StreamState => ({
    sessions: initialSnapshot?.sessions ?? [],
    staleAfterMs: initialSnapshot?.staleAfterMs ?? 600_000,
    health: initialHealth,
    connection: initialSnapshot ? "live" : "offline",
    retryAt: null,
    failures: 0,
    updatedAt: {},
    announcement: null,
  }));

  const forceConnectRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let disposed = false;

    function connect() {
      if (disposed) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      source?.close();
      const current = new EventSource("/api/stream");
      source = current;
      current.addEventListener("snapshot", (event) => {
        const snapshot = parseFrame<SessionsSnapshot>(event);
        if (!snapshot) return;
        failures = 0;
        dispatch({ type: "snapshot", snapshot });
      });
      current.addEventListener("session", (event) => {
        const session = parseFrame<SessionView>(event);
        if (session) dispatch({ type: "session", session, at: Date.now() });
      });
      current.addEventListener("session_removed", (event) => {
        const removed = parseFrame<{ sessionId: string }>(event);
        if (removed?.sessionId) dispatch({ type: "removed", sessionId: removed.sessionId });
      });
      current.addEventListener("health", (event) => {
        const health = parseFrame<HealthReport>(event);
        if (health) dispatch({ type: "health", health });
      });
      current.onerror = () => {
        current.close();
        if (disposed || source !== current) return;
        source = null;
        failures += 1;
        const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (failures - 1));
        dispatch({ type: "error", retryAt: Date.now() + delay });
        timer = setTimeout(connect, delay);
      };
    }

    forceConnectRef.current = () => {
      failures = 0;
      connect();
    };
    connect();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      source?.close();
      forceConnectRef.current = null;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [sessionsRes, healthRes] = await Promise.all([
        fetch("/api/sessions", { cache: "no-store" }),
        fetch("/api/health", { cache: "no-store" }),
      ]);
      if (sessionsRes.ok) dispatch({ type: "snapshot", snapshot: (await sessionsRes.json()) as SessionsSnapshot });
      if (healthRes.ok) dispatch({ type: "health", health: (await healthRes.json()) as HealthReport });
    } catch {
      /* the stream's own error path reports the outage */
    }
  }, []);

  const connection = state.connection;
  const reconnect = useCallback(() => {
    if (connection === "live") {
      void refresh();
      return;
    }
    forceConnectRef.current?.();
  }, [connection, refresh]);

  useEffect(() => {
    if (connection !== "live") return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        if (res.ok) dispatch({ type: "health", health: (await res.json()) as HealthReport });
      } catch {
        /* stream error path handles outages */
      }
    }, HEALTH_POLL_MS);
    return () => clearInterval(timer);
  }, [connection]);

  const announcementId = state.announcement?.id;
  useEffect(() => {
    if (announcementId === undefined) return;
    const timer = setTimeout(() => dispatch({ type: "clear-announcement", id: announcementId }), ANNOUNCEMENT_TTL_MS);
    return () => clearTimeout(timer);
  }, [announcementId]);

  return { ...state, reconnect, refresh };
}
