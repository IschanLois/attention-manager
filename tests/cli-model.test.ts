import { describe, expect, it } from "vitest";
import { humaniseEventType, relativeTime, relativeTimeAgo, shortId, sourceLabel } from "@/cli/model/format";
import { applyFilters, DEFAULT_FILTERS, parseFilterFlags, prioritiesAtLeast } from "@/cli/model/filters";
import { announcementFor } from "@/cli/model/announce";
import { isStale } from "@/cli/model/sort";
import type { SessionView } from "@/cli/model/types";

const NOW = Date.parse("2026-10-09T10:00:00.000Z");

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: "11111111-2222-3333-4444-555555555555",
    label: "demo",
    startedAt: "2026-10-09T09:00:00.000Z",
    lastSeenAt: "2026-10-09T09:59:00.000Z",
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

describe("relativeTime", () => {
  it("formats seconds, minutes, hours and days", () => {
    expect(relativeTime(new Date(NOW - 5_000).toISOString(), NOW)).toBe("just now");
    expect(relativeTime(new Date(NOW - 45_000).toISOString(), NOW)).toBe("45s");
    expect(relativeTime(new Date(NOW - 2 * 60_000).toISOString(), NOW)).toBe("2m");
    expect(relativeTime(new Date(NOW - 14 * 60_000).toISOString(), NOW)).toBe("14m");
    expect(relativeTime(new Date(NOW - 70 * 60_000).toISOString(), NOW)).toBe("1h 10m");
    expect(relativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("3h");
    expect(relativeTime(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe("2d");
  });

  it("treats future or unparsable timestamps as just now / unknown", () => {
    expect(relativeTime(new Date(NOW + 60_000).toISOString(), NOW)).toBe("just now");
    expect(relativeTime("not-a-date", NOW)).toBe("unknown");
  });

  it("appends ago except for just now", () => {
    expect(relativeTimeAgo(new Date(NOW - 14 * 60_000).toISOString(), NOW)).toBe("14m ago");
    expect(relativeTimeAgo(new Date(NOW - 1_000).toISOString(), NOW)).toBe("just now");
  });
});

describe("humaniseEventType", () => {
  it("maps known event types to readable labels", () => {
    expect(humaniseEventType("permission_request")).toBe("Permission requested");
    expect(humaniseEventType("turn_complete")).toBe("Turn complete");
    expect(humaniseEventType("tool_failure")).toBe("Tool failed");
  });

  it("falls back to a readable form for unknown types and null", () => {
    expect(humaniseEventType("some_new_thing")).toBe("Some new thing");
    expect(humaniseEventType(null)).toBe("No events yet");
  });
});

describe("shortId and sourceLabel", () => {
  it("returns the last four characters", () => {
    expect(shortId("11111111-2222-3333-4444-555555555555")).toBe("5555");
    expect(shortId("ab")).toBe("ab");
  });

  it("labels classification sources", () => {
    expect(sourceLabel("rule", null)).toBe("Observed");
    expect(sourceLabel("ai", 0.724)).toBe("AI confidence 72%");
    expect(sourceLabel("ai", null)).toBe("AI confidence unknown");
    expect(sourceLabel("fallback", 0.9)).toBe("Observed · AI unavailable");
  });
});

describe("isStale", () => {
  it("is stale when last seen exceeds the threshold and session is active", () => {
    const s = session({ lastSeenAt: new Date(NOW - 11 * 60_000).toISOString() });
    expect(isStale(s, NOW, 600_000)).toBe(true);
    expect(isStale(session({ lastSeenAt: new Date(NOW - 60_000).toISOString() }), NOW, 600_000)).toBe(false);
  });

  it("never marks ended sessions stale", () => {
    const s = session({ status: "ended", lastSeenAt: new Date(NOW - 86_400_000).toISOString() });
    expect(isStale(s, NOW, 600_000)).toBe(false);
  });
});

describe("filters", () => {
  it("parses list flags into filters", () => {
    const parsed = parseFilterFlags({ status: "working,error", minPriority: "high", minRisk: "medium", sort: "recent" });
    expect(parsed).toEqual({
      ok: true,
      filters: { statuses: ["working", "error"], priorities: ["critical", "high"], risks: ["critical", "high", "medium"], hideEnded: true, sort: "recent", label: "" },
    });
    expect(parseFilterFlags({})).toEqual({ ok: true, filters: DEFAULT_FILTERS });
  });

  it("shows ended sessions with --all or when filtering for them", () => {
    expect(parseFilterFlags({ all: true })).toMatchObject({ ok: true, filters: { hideEnded: false } });
    expect(parseFilterFlags({ status: "ended" })).toMatchObject({ ok: true, filters: { hideEnded: false, statuses: ["ended"] } });
  });

  it("rejects unknown flag values with the allowed list", () => {
    const status = parseFilterFlags({ status: "bogus,idle" });
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.error).toMatch(/unknown --status value "bogus".*needs_attention/);
    expect(parseFilterFlags({ minPriority: "severe" }).ok).toBe(false);
    expect(parseFilterFlags({ sort: "weird" }).ok).toBe(false);
  });

  it("returns the priorities at or above a minimum", () => {
    expect(prioritiesAtLeast("critical")).toEqual(["critical"]);
    expect(prioritiesAtLeast("medium")).toEqual(["critical", "high", "medium"]);
    expect(prioritiesAtLeast("none")).toEqual(["critical", "high", "medium", "low", "none"]);
  });

  it("filters by a label or id fragment, case-insensitively", () => {
    const list = [session({ sessionId: "a-aaaaaaaaaa", label: "Billing-API" }), session({ sessionId: "b-bbbbbbbbbb", label: "docs" })];
    expect(applyFilters(list, { ...DEFAULT_FILTERS, label: "billing" }).map((s) => s.sessionId)).toEqual(["a-aaaaaaaaaa"]);
    expect(applyFilters(list, { ...DEFAULT_FILTERS, label: "bbbb" }).map((s) => s.sessionId)).toEqual(["b-bbbbbbbbbb"]);
  });

  it("applies status, priority, risk and hide-ended filters", () => {
    const list = [
      session({ sessionId: "a-aaaaaaaaaa", status: "working", priority: "none", taskSeverity: "critical" }),
      session({ sessionId: "b-bbbbbbbbbb", status: "needs_attention", priority: "high" }),
      session({ sessionId: "c-cccccccccc", status: "ended", priority: "none", endedAt: "2026-10-09T09:30:00.000Z" }),
    ];
    expect(applyFilters(list, { ...DEFAULT_FILTERS, risks: ["critical"] }).map((s) => s.sessionId)).toEqual(["a-aaaaaaaaaa"]);
    expect(applyFilters(list, { ...DEFAULT_FILTERS, risks: ["none"], hideEnded: false }).map((s) => s.sessionId)).toEqual([
      "b-bbbbbbbbbb",
      "c-cccccccccc",
    ]);
    expect(applyFilters(list, DEFAULT_FILTERS).map((s) => s.sessionId)).toEqual(["a-aaaaaaaaaa", "b-bbbbbbbbbb"]);
    expect(applyFilters(list, { ...DEFAULT_FILTERS, hideEnded: false }).length).toBe(3);
    expect(applyFilters(list, { ...DEFAULT_FILTERS, priorities: ["high"] }).map((s) => s.sessionId)).toEqual(["b-bbbbbbbbbb"]);
    expect(applyFilters(list, { ...DEFAULT_FILTERS, statuses: ["ended"], hideEnded: false }).map((s) => s.sessionId)).toEqual([
      "c-cccccccccc",
    ]);
  });
});

describe("announcementFor", () => {
  it("announces a session that starts needing input", () => {
    const before = session();
    const after = session({ status: "needs_attention", priority: "high", attentionReason: "Waiting for permission" });
    expect(announcementFor(before, after)).toBe("Session demo now needs input: Waiting for permission");
    expect(announcementFor(after, after)).toBeNull();
  });

  it("announces when an active session starts doing critical-risk work", () => {
    const before = session({ taskSeverity: "high" });
    const after = session({ taskSeverity: "critical", taskSeverityReason: "Dropping the legacy_users table" });
    expect(announcementFor(before, after)).toBe("Session demo is now doing critical-risk work: Dropping the legacy_users table");
    expect(announcementFor(undefined, session({ taskSeverity: "critical" }))).toBe("Session demo is now doing critical-risk work");
    expect(announcementFor(after, after)).toBeNull();
    expect(announcementFor(before, session({ taskSeverity: "critical", status: "ended" }))).toBeNull();
  });

  it("combines both announcements when they happen on the same update", () => {
    const after = session({ status: "error", attentionReason: "Tool failed", taskSeverity: "critical", taskSeverityReason: "Force push" });
    expect(announcementFor(session(), after)).toBe("Session demo reported an error: Tool failed. Session demo is now doing critical-risk work: Force push");
  });
});
