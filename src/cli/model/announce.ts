import { sessionLabel } from "./format.ts";
import type { SessionView } from "./types.ts";

function withReason(sentence: string, reason: string | null): string {
  return reason ? `${sentence}: ${reason}` : sentence;
}

export function isAlerting(session: Pick<SessionView, "status"> | undefined): boolean {
  return session?.status === "needs_attention" || session?.status === "error";
}

function attentionTransition(previous: SessionView | undefined, next: SessionView): string | null {
  if (!isAlerting(next) || isAlerting(previous)) return null;
  const what = next.status === "error" ? "reported an error" : "now needs input";
  return withReason(`Session ${sessionLabel(next.label, next.sessionId)} ${what}`, next.attentionReason);
}

function riskTransition(previous: SessionView | undefined, next: SessionView): string | null {
  if (next.status === "ended" || next.taskSeverity !== "critical" || previous?.taskSeverity === "critical") return null;
  return withReason(`Session ${sessionLabel(next.label, next.sessionId)} is now doing critical-risk work`, next.taskSeverityReason);
}

export function announcementFor(previous: SessionView | undefined, next: SessionView): string | null {
  const attention = attentionTransition(previous, next);
  const risk = riskTransition(previous, next);
  if (attention && risk) return `${attention}. ${risk}`;
  return attention ?? risk;
}
