import {
  PRIORITY_RANK,
  type Classification,
  type NormalizedEvent,
  type Priority,
  type Session,
} from "../schemas.ts";

export const FAILURE_WINDOW_MS = 2 * 60_000;
export const FAILURE_ESCALATION_COUNT = 3;
const QUESTION_PATTERN = /\?|\b(should i|do you want|would you like|let me know|which (one|option|approach)|please confirm|can i proceed)\b/i;

function newSession(event: NormalizedEvent): Session {
  return {
    sessionId: event.sessionId,
    label: event.label,
    startedAt: null,
    lastSeenAt: event.receivedAt,
    lastEventType: null,
    status: "starting",
    priority: "none",
    attentionReason: null,
    classificationConfidence: null,
    classificationSource: "rule",
    classifiedAt: null,
    classificationEvidence: [],
    classificationError: null,
    endedAt: null,
    recentFailureTimes: [],
    pendingPermissionToolUseId: null,
    eventSeq: 0,
  };
}

function affectsOtherTool(session: Session, event: NormalizedEvent): boolean {
  return session.status === "needs_attention" && session.pendingPermissionToolUseId !== null && event.toolUseId !== null && event.toolUseId !== session.pendingPermissionToolUseId;
}

function clearAttention(session: Session): Session {
  return {
    ...session,
    priority: "none",
    attentionReason: null,
    classificationConfidence: null,
    classificationSource: "rule",
    classifiedAt: null,
    classificationEvidence: [],
    classificationError: null,
    pendingPermissionToolUseId: null,
  };
}

function withRule(session: Session, status: Session["status"], priority: Priority, reason: string | null): Session {
  return { ...clearAttention(session), status, priority, attentionReason: reason };
}

function working(session: Session): Session {
  return withRule(session, "working", "none", null);
}

function recentFailures(session: Session, at: string): string[] {
  const cutoff = Date.parse(at) - FAILURE_WINDOW_MS;
  return session.recentFailureTimes.filter((t) => Date.parse(t) >= cutoff);
}

export function looksLikeQuestion(text: string | null): boolean {
  return !!text && QUESTION_PATTERN.test(text);
}

function applyEvent(session: Session, event: NormalizedEvent): Session {
  switch (event.type) {
    case "session_start":
      if (event.source === "compact" && session.status !== "ended") return session;
      return { ...withRule(session, "starting", "none", null), startedAt: session.startedAt ?? event.receivedAt, endedAt: null, recentFailureTimes: [] };
    case "prompt":
    case "tool_start":
      return working(session);
    case "tool_end":
      if (session.status === "completed" && session.pendingPermissionToolUseId === null) return session;
      if (affectsOtherTool(session, event)) return session;
      return working(session);
    case "tool_failure": {
      if (event.isInterrupt) return withRule(session, "idle", "low", "Interrupted by the user");
      const failures = [...recentFailures(session, event.receivedAt), event.receivedAt];
      if (affectsOtherTool(session, event)) return { ...session, recentFailureTimes: failures };
      const tool = event.toolName ?? "A tool";
      const escalated = failures.length >= FAILURE_ESCALATION_COUNT;
      const reason = escalated
        ? `${failures.length} tool failures in the last ${FAILURE_WINDOW_MS / 60_000} minutes (latest: ${tool})`
        : `${tool} failed; the agent may recover on its own`;
      return { ...withRule(session, "error", escalated ? "medium" : "low", reason), recentFailureTimes: failures };
    }
    case "permission_request":
      return {
        ...withRule(session, "needs_attention", "high", `Waiting for permission to run ${event.toolName ?? "a tool"}`),
        pendingPermissionToolUseId: event.toolUseId,
      };
    case "notification":
      return applyNotification(session, event);
    case "turn_complete": {
      if (looksLikeQuestion(event.classifierText)) {
        return withRule(session, "completed", "medium", "Turn finished and the assistant appears to be asking a question");
      }
      return withRule(session, "completed", "low", "Turn finished; waiting for the next prompt");
    }
    case "subagent_stop":
    case "compact":
      return session;
    case "session_end":
      return { ...withRule(session, "ended", "none", null), endedAt: event.receivedAt };
  }
}

function applyNotification(session: Session, event: NormalizedEvent): Session {
  switch (event.notificationType) {
    case "permission_prompt":
      if (session.status === "needs_attention" && session.pendingPermissionToolUseId) return { ...session };
      return withRule(session, "needs_attention", "high", "Waiting for a permission decision");
    case "elicitation_dialog":
      return withRule(session, "needs_attention", "high", "Waiting for input in a dialog");
    case "idle_prompt":
      return withRule(session, "needs_attention", "medium", "Waiting for your input");
    case "auth_success":
      return session;
    default:
      if (session.status === "needs_attention" && session.classificationSource === "rule") return session;
      return { ...withRule(session, session.status, higherPriority(session.priority, "medium"), "Unclassified notification"), classificationSource: "fallback" };
  }
}

export function reduceSession(previous: Session | null, event: NormalizedEvent): Session {
  const base = previous ?? newSession(event);
  const stamped: Session = {
    ...base,
    label: event.label ?? base.label,
    lastSeenAt: event.receivedAt,
    lastEventType: event.type,
    eventSeq: base.eventSeq + 1,
  };
  if (stamped.status === "ended" && event.type !== "session_start") return stamped;
  return applyEvent(stamped, event);
}

export function shouldClassify(session: Session, event: NormalizedEvent): boolean {
  if (session.status === "ended" || !event.classifierText) return false;
  switch (event.type) {
    case "notification":
      return !["permission_prompt", "idle_prompt", "elicitation_dialog", "auth_success"].includes(event.notificationType ?? "");
    case "tool_failure":
      return !event.isInterrupt;
    case "turn_complete":
      return looksLikeQuestion(event.classifierText);
    default:
      return false;
  }
}

export function priorityFloor(event: NormalizedEvent): Priority {
  switch (event.type) {
    case "permission_request":
      return "high";
    case "notification":
      if (event.notificationType === "permission_prompt" || event.notificationType === "elicitation_dialog") return "high";
      if (event.notificationType === "idle_prompt") return "medium";
      return "none";
    case "tool_failure":
      return event.isInterrupt ? "low" : "low";
    case "turn_complete":
      return "low";
    default:
      return "none";
  }
}

function higherPriority(a: Priority, b: Priority): Priority {
  return PRIORITY_RANK[a] <= PRIORITY_RANK[b] ? a : b;
}

export function isCurrentTrigger(session: Session, trigger: NormalizedEvent, triggerSeq?: number): boolean {
  if (triggerSeq !== undefined) return session.eventSeq === triggerSeq;
  return session.lastSeenAt === trigger.receivedAt && session.lastEventType === trigger.type;
}

export function applyClassification(session: Session, trigger: NormalizedEvent, result: Classification, classifiedAt: string, triggerSeq?: number): Session {
  if (session.status === "ended") return session;
  if (!isCurrentTrigger(session, trigger, triggerSeq)) return session;

  let priority: Priority = result.needs_attention ? result.priority : "none";
  if (result.needs_attention && priority === "none") priority = "low";
  if (priority === "critical" && session.status !== "error" && session.status !== "needs_attention") priority = "high";
  priority = higherPriority(priority, priorityFloor(trigger));

  return {
    ...session,
    priority,
    attentionReason: result.reason.trim() || session.attentionReason,
    classificationConfidence: result.confidence,
    classificationSource: "ai",
    classifiedAt,
    classificationEvidence: result.evidence,
    classificationError: null,
  };
}

export function recordClassificationFailure(session: Session, trigger: NormalizedEvent, error: string, at: string, triggerSeq?: number): Session {
  if (!isCurrentTrigger(session, trigger, triggerSeq)) return session;
  return { ...session, classificationSource: "fallback", classificationError: error, classifiedAt: at };
}

export function isStale(session: Session, nowMs: number, staleAfterMs: number): boolean {
  if (session.status === "ended") return false;
  return nowMs - Date.parse(session.lastSeenAt) > staleAfterMs;
}

export function sortSessions(sessions: Session[], nowMs: number, staleAfterMs: number): Session[] {
  return [...sessions].sort((a, b) => {
    const endedDiff = Number(a.status === "ended") - Number(b.status === "ended");
    if (endedDiff !== 0) return endedDiff;
    const priorityDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    const staleDiff = Number(isStale(a, nowMs, staleAfterMs)) - Number(isStale(b, nowMs, staleAfterMs));
    if (staleDiff !== 0) return staleDiff;
    const recency = Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
    if (recency !== 0) return recency;
    return a.sessionId.localeCompare(b.sessionId);
  });
}
