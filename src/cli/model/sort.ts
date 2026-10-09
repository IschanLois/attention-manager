import type { Priority, SessionView, SortMode } from "./types.ts";

const PRIORITY_RANK: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };

export interface SortOptions {
  nowMs: number;
  staleAfterMs: number;
  mode: SortMode;
}

export function isStale(session: Pick<SessionView, "status" | "lastSeenAt">, nowMs: number, staleAfterMs: number): boolean {
  if (session.status === "ended") return false;
  const seen = Date.parse(session.lastSeenAt);
  if (Number.isNaN(seen)) return true;
  return nowMs - seen > staleAfterMs;
}

function phaseRank(status: SessionView["status"]): number {
  if (status === "ended") return 2;
  return status === "completed" || status === "idle" ? 1 : 0;
}

function compareAttention(a: SessionView, b: SessionView, nowMs: number, staleAfterMs: number): number {
  const phaseDiff = phaseRank(a.status) - phaseRank(b.status);
  if (phaseDiff !== 0) return phaseDiff;
  const severityDiff = PRIORITY_RANK[a.taskSeverity] - PRIORITY_RANK[b.taskSeverity];
  if (severityDiff !== 0) return severityDiff;
  const priorityDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (priorityDiff !== 0) return priorityDiff;
  const staleDiff = Number(isStale(a, nowMs, staleAfterMs)) - Number(isStale(b, nowMs, staleAfterMs));
  if (staleDiff !== 0) return staleDiff;
  const recency = Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
  if (recency !== 0 && !Number.isNaN(recency)) return recency;
  return a.sessionId.localeCompare(b.sessionId);
}

function compareRecent(a: SessionView, b: SessionView): number {
  const recency = Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
  return Number.isNaN(recency) ? 0 : recency;
}

function compareLabel(a: SessionView, b: SessionView): number {
  if (a.label === null || b.label === null) return Number(a.label === null) - Number(b.label === null);
  return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
}

export function sortSessions(sessions: readonly SessionView[], options: SortOptions): SessionView[] {
  const { nowMs, staleAfterMs, mode } = options;
  const primary = mode === "recent" ? compareRecent : mode === "label" ? compareLabel : null;
  return [...sessions].sort((a, b) => {
    if (primary) {
      const diff = primary(a, b);
      if (diff !== 0) return diff;
    }
    return compareAttention(a, b, nowMs, staleAfterMs);
  });
}

export function needsAttention(session: Pick<SessionView, "status" | "priority">): boolean {
  return session.status !== "ended" && PRIORITY_RANK[session.priority] <= PRIORITY_RANK.medium;
}

export function attentionCount(sessions: readonly SessionView[]): number {
  return sessions.filter(needsAttention).length;
}

export function isHighRisk(session: Pick<SessionView, "status" | "taskSeverity">): boolean {
  return session.status !== "ended" && PRIORITY_RANK[session.taskSeverity] <= PRIORITY_RANK.high;
}

export function highRiskCount(sessions: readonly SessionView[]): number {
  return sessions.filter(isHighRisk).length;
}
