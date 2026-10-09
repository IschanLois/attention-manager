import { describe, expect, it } from "vitest";
import { humaniseEventType, relativeTime, relativeTimeAgo, shortId, sourceLabel } from "@/lib/format";
import { applyFilters, DEFAULT_FILTERS, parseFilters, serializeFilters } from "@/lib/filters";
import { isStale } from "@/lib/sort";
import type { SessionView } from "@/lib/types";

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
    expect(sourceLabel("ai", 0.724)).toBe("AI · 72%");
    expect(sourceLabel("ai", null)).toBe("AI · unrated");
    expect(sourceLabel("fallback", 0.9)).toBe("Unclassified");
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
  it("parses and serialises url search params round-trip", () => {
    const parsed = parseFilters({ status: "working,error", priority: "high", ended: "show", sort: "recent" });
    expect(parsed).toEqual({ statuses: ["working", "error"], priorities: ["high"], hideEnded: false, sort: "recent" });
    expect(serializeFilters(parsed)).toBe("status=working%2Cerror&priority=high&ended=show&sort=recent");
    expect(serializeFilters(DEFAULT_FILTERS)).toBe("");
  });

  it("ignores unknown values", () => {
    const parsed = parseFilters({ status: "bogus,idle", priority: ["nope"], sort: "weird" });
    expect(parsed).toEqual({ statuses: ["idle"], priorities: [], hideEnded: true, sort: "attention" });
  });

  it("applies status, priority and hide-ended filters", () => {
    const list = [
      session({ sessionId: "a-aaaaaaaaaa", status: "working", priority: "none" }),
      session({ sessionId: "b-bbbbbbbbbb", status: "needs_attention", priority: "high" }),
      session({ sessionId: "c-cccccccccc", status: "ended", priority: "none", endedAt: "2026-10-09T09:30:00.000Z" }),
    ];
    expect(applyFilters(list, DEFAULT_FILTERS).map((s) => s.sessionId)).toEqual(["a-aaaaaaaaaa", "b-bbbbbbbbbb"]);
    expect(applyFilters(list, { ...DEFAULT_FILTERS, hideEnded: false }).length).toBe(3);
    expect(applyFilters(list, { ...DEFAULT_FILTERS, priorities: ["high"] }).map((s) => s.sessionId)).toEqual(["b-bbbbbbbbbb"]);
    expect(applyFilters(list, { ...DEFAULT_FILTERS, statuses: ["ended"], hideEnded: false }).map((s) => s.sessionId)).toEqual([
      "c-cccccccccc",
    ]);
  });
});
