import { EXIT_ERROR, EXIT_MISCONFIGURED, EXIT_OK, type ListFlags } from "../args.ts";
import { createClient, RECEIVER_NOT_RUNNING, ReceiverUnavailableError } from "../client.ts";
import { focusContext, type CliContext } from "../context.ts";
import { planFocus } from "../focus/select.ts";
import { applyFilters, parseFilterFlags } from "../model/filters.ts";
import { relativeTime, sessionLabel } from "../model/format.ts";
import { sortSessions } from "../model/sort.ts";
import { PRIORITY_LABELS, STATUS_LABELS, type SessionView } from "../model/types.ts";

export type SessionMatch = { kind: "match"; session: SessionView } | { kind: "ambiguous"; candidates: string[] } | { kind: "none" };

export function matchSession(sessions: readonly SessionView[], query: string): SessionMatch {
  const q = query.trim().toLowerCase();
  const name = (s: SessionView) => sessionLabel(s.label, s.sessionId);
  const tiers: Array<(s: SessionView) => boolean> = [
    (s) => s.sessionId.toLowerCase() === q,
    (s) => (s.label ?? "").toLowerCase() === q,
    (s) => s.sessionId.toLowerCase().startsWith(q) || (s.label ?? "").toLowerCase().startsWith(q),
  ];
  for (const tier of tiers) {
    const hits = sessions.filter(tier);
    if (hits.length === 1) return { kind: "match", session: hits[0]! };
    if (hits.length > 1) return { kind: "ambiguous", candidates: hits.map(name) };
  }
  return { kind: "none" };
}

export interface ListJson {
  version: 1;
  generatedAt: string;
  sessions: Array<{
    id: string;
    label: string | null;
    status: SessionView["status"];
    priority: SessionView["priority"];
    reason: string | null;
    reasonSource: SessionView["classificationSource"];
    reasonConfidence: number | null;
    taskSeverity: SessionView["taskSeverity"];
    taskSeveritySource: SessionView["taskSeveritySource"];
    taskSeverityConfidence: number | null;
    taskSeverityReason: string | null;
    taskSummary: string | null;
    lastSeenAt: string;
    startedAt: string | null;
    endedAt: string | null;
    stale: boolean;
    focusable: boolean;
    terminal: SessionView["terminal"];
  }>;
}

export function toListJson(sessions: readonly SessionView[], nowMs: number, focusable: (session: SessionView) => boolean): ListJson {
  return {
    version: 1,
    generatedAt: new Date(nowMs).toISOString(),
    sessions: sessions.map((s) => ({
      id: s.sessionId,
      label: s.label,
      status: s.status,
      priority: s.priority,
      reason: s.attentionReason,
      reasonSource: s.classificationSource,
      reasonConfidence: s.classificationConfidence,
      taskSeverity: s.taskSeverity,
      taskSeveritySource: s.taskSeveritySource,
      taskSeverityConfidence: s.taskSeverityConfidence,
      taskSeverityReason: s.taskSeverityReason,
      taskSummary: s.taskSummary,
      lastSeenAt: s.lastSeenAt,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      stale: s.stale,
      focusable: focusable(s),
      terminal: s.terminal,
    })),
  };
}

function table(sessions: readonly SessionView[], nowMs: number): string[] {
  if (sessions.length === 0) return ["No sessions match."];
  const rows = sessions.map((s) => [sessionLabel(s.label, s.sessionId), STATUS_LABELS[s.status], PRIORITY_LABELS[s.priority], relativeTime(s.lastSeenAt, nowMs), s.attentionReason ?? s.taskSummary ?? ""]);
  const header = ["SESSION", "STATUS", "PRIORITY", "SEEN", "REASON"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd();
  return [line(header), ...rows.map(line)];
}

export async function fetchSessions(ctx: CliContext): Promise<{ sessions: SessionView[]; nowMs: number; staleAfterMs: number } | null> {
  try {
    const snapshot = await createClient(ctx.receiverUrl).sessions();
    return { sessions: snapshot.sessions, nowMs: Date.parse(snapshot.now), staleAfterMs: snapshot.staleAfterMs };
  } catch (error) {
    if (error instanceof ReceiverUnavailableError) return null;
    throw error;
  }
}

export async function runList(ctx: CliContext, flags: Partial<ListFlags>): Promise<number> {
  const parsed = parseFilterFlags(flags);
  if (!parsed.ok) {
    ctx.err(parsed.error);
    return EXIT_MISCONFIGURED;
  }
  const snapshot = await fetchSessions(ctx);
  if (!snapshot) {
    ctx.err(RECEIVER_NOT_RUNNING);
    return EXIT_ERROR;
  }
  const { filters } = parsed;
  const sessions = sortSessions(applyFilters(snapshot.sessions, filters), { nowMs: snapshot.nowMs, staleAfterMs: snapshot.staleAfterMs, mode: filters.sort });
  const focus = focusContext(ctx);
  if (flags.json) ctx.out(JSON.stringify(toListJson(sessions, snapshot.nowMs, (s) => planFocus(s.terminal, focus).length > 0), null, 2));
  else for (const line of table(sessions, snapshot.nowMs)) ctx.out(line);
  return EXIT_OK;
}
