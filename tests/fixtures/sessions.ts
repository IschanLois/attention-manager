import type { SessionView } from "@/core/sessions/view";

export const FIXTURE_NOW = Date.parse("2026-10-09T10:00:00.000Z");

export function minutesAgo(minutes: number): string {
  return new Date(FIXTURE_NOW - minutes * 60_000).toISOString();
}

export function sessionView(overrides: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: "sess-fixture-0001",
    label: "proj",
    startedAt: minutesAgo(60),
    lastSeenAt: minutesAgo(1),
    lastEventType: "tool_end",
    status: "working",
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
    eventSeq: 1,
    taskSummary: null,
    recentActions: [],
    lastNarration: null,
    taskRuleSeverity: "none",
    taskSeverity: "none",
    taskSeveritySource: "rule",
    taskSeverityReason: null,
    taskSeverityEvidence: [],
    taskSeverityConfidence: null,
    taskClassifiedAt: null,
    terminal: null,
    stale: false,
    ...overrides,
  };
}
