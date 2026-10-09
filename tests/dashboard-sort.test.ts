import { describe, expect, it } from "vitest";
import { attentionCount, highRiskCount, sortSessions } from "@/lib/sort";
import type { SessionView } from "@/lib/types";

const NOW = Date.parse("2026-10-09T10:00:00.000Z");
const STALE_AFTER = 600_000;

function at(minutesAgo: number): string {
  return new Date(NOW - minutesAgo * 60_000).toISOString();
}

function session(id: string, overrides: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: id,
    label: id,
    startedAt: at(60),
    lastSeenAt: at(1),
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
    eventSeq: 0,
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

describe("sortSessions (attention)", () => {
  it("orders active before ended, then by priority, then task severity, stale after fresh, then recency, then id", () => {
    const input = [
      session("ended-high", { status: "ended", priority: "high", endedAt: at(2), lastSeenAt: at(0) }),
      session("low-fresh", { priority: "low" }),
      session("high-stale", { priority: "high", status: "needs_attention", lastSeenAt: at(30) }),
      session("high-fresh-old", { priority: "high", status: "needs_attention", lastSeenAt: at(5) }),
      session("high-fresh-new", { priority: "high", status: "needs_attention", lastSeenAt: at(2) }),
      session("high-risky-stale", { priority: "high", status: "needs_attention", lastSeenAt: at(30), taskSeverity: "critical" }),
      session("critical", { priority: "critical", status: "error", lastSeenAt: at(9) }),
      session("none-b", { lastSeenAt: at(3) }),
      session("none-a", { lastSeenAt: at(3) }),
      session("none-risky-old", { lastSeenAt: at(40), taskSeverity: "medium" }),
    ];
    const sorted = sortSessions(input, { nowMs: NOW, staleAfterMs: STALE_AFTER, mode: "attention" });
    expect(sorted.map((s) => s.sessionId)).toEqual([
      "critical",
      "high-risky-stale",
      "high-fresh-new",
      "high-fresh-old",
      "high-stale",
      "low-fresh",
      "none-risky-old",
      "none-a",
      "none-b",
      "ended-high",
    ]);
  });

  it("ranks task severity below attention priority but above freshness", () => {
    const input = [
      session("low-attention-no-risk", { priority: "low", taskSeverity: "none" }),
      session("no-attention-critical-risk", { priority: "none", taskSeverity: "critical" }),
      session("no-attention-high-risk", { priority: "none", taskSeverity: "high" }),
    ];
    const sorted = sortSessions(input, { nowMs: NOW, staleAfterMs: STALE_AFTER, mode: "attention" });
    expect(sorted.map((s) => s.sessionId)).toEqual(["low-attention-no-risk", "no-attention-critical-risk", "no-attention-high-risk"]);
  });

  it("does not mutate the input", () => {
    const input = [session("b"), session("a")];
    const copy = [...input];
    sortSessions(input, { nowMs: NOW, staleAfterMs: STALE_AFTER, mode: "attention" });
    expect(input).toEqual(copy);
  });
});

describe("sortSessions (other modes)", () => {
  it("recent sorts by last seen descending with attention as the tiebreak", () => {
    const input = [
      session("old-critical", { priority: "critical", lastSeenAt: at(10) }),
      session("new-none", { lastSeenAt: at(1) }),
      session("new-high", { priority: "high", lastSeenAt: at(1) }),
    ];
    const sorted = sortSessions(input, { nowMs: NOW, staleAfterMs: STALE_AFTER, mode: "recent" });
    expect(sorted.map((s) => s.sessionId)).toEqual(["new-high", "new-none", "old-critical"]);
  });

  it("label sorts alphabetically, case-insensitively, with unlabeled sessions last", () => {
    const input = [
      session("c", { label: "zeta" }),
      session("b", { label: null }),
      session("a", { label: "Alpha" }),
      session("d", { label: "beta" }),
    ];
    const sorted = sortSessions(input, { nowMs: NOW, staleAfterMs: STALE_AFTER, mode: "label" });
    expect(sorted.map((s) => s.sessionId)).toEqual(["a", "d", "c", "b"]);
  });
});

describe("attentionCount", () => {
  it("counts active sessions with critical, high or medium priority", () => {
    const input = [
      session("1", { priority: "critical" }),
      session("2", { priority: "medium" }),
      session("3", { priority: "low" }),
      session("4", { priority: "high", status: "ended", endedAt: at(1) }),
    ];
    expect(attentionCount(input)).toBe(2);
  });
});

describe("highRiskCount", () => {
  it("counts active sessions whose task severity is critical or high", () => {
    const input = [
      session("1", { taskSeverity: "critical" }),
      session("2", { taskSeverity: "high", status: "idle" }),
      session("3", { taskSeverity: "medium" }),
      session("4", { taskSeverity: "critical", status: "ended", endedAt: at(1) }),
      session("5", { priority: "critical", taskSeverity: "none" }),
    ];
    expect(highRiskCount(input)).toBe(2);
  });
});
