import { describe, expect, it } from "vitest";
import { normalizeHookEvent } from "@/core/events/normalize";
import {
  applyClassification,
  applyTaskClassification,
  isStale,
  reduceSession,
  shouldClassify,
  shouldClassifyTask,
  sortSessions,
} from "@/core/sessions/state-machine";
import type { NormalizedEvent, Session } from "@/core/schemas";
import * as fx from "./fixtures/hook-events";

let clock = Date.parse("2026-10-09T08:00:00.000Z");

function ev(raw: unknown, advanceMs = 1000): NormalizedEvent {
  clock += advanceMs;
  const result = normalizeHookEvent(raw, new Date(clock).toISOString());
  if (!result.ok) throw new Error(`fixture failed to normalize: ${result.reason}`);
  return result.event;
}

function run(events: NormalizedEvent[], start: Session | null = null): Session {
  return events.reduce<Session | null>((s, e) => reduceSession(s, e), start)!;
}

describe("reduceSession: lifecycle", () => {
  it("creates a starting session on SessionStart with label and timestamps", () => {
    const e = ev(fx.sessionStart());
    const s = reduceSession(null, e);
    expect(s.sessionId).toBe(fx.SESSION_A);
    expect(s.status).toBe("starting");
    expect(s.priority).toBe("none");
    expect(s.label).toBe("my-app");
    expect(s.startedAt).toBe(e.receivedAt);
    expect(s.lastSeenAt).toBe(e.receivedAt);
    expect(s.lastEventType).toBe("session_start");
    expect(s.classificationSource).toBe("rule");
    expect(s.endedAt).toBeNull();
  });

  it("creates a session from any first event, even without SessionStart", () => {
    const s = reduceSession(null, ev(fx.preToolUse()));
    expect(s.status).toBe("working");
    expect(s.startedAt).toBeNull();
  });

  it("moves to working on prompt, tool start and tool end", () => {
    expect(run([ev(fx.sessionStart()), ev(fx.userPromptSubmit())]).status).toBe("working");
    expect(run([ev(fx.sessionStart()), ev(fx.preToolUse())]).status).toBe("working");
    expect(run([ev(fx.sessionStart()), ev(fx.preToolUse()), ev(fx.postToolUse())]).status).toBe("working");
  });

  it("treats Stop as a completed turn, not as a terminated session", () => {
    const s = run([ev(fx.sessionStart()), ev(fx.userPromptSubmit()), ev(fx.stop())]);
    expect(s.status).toBe("completed");
    expect(s.endedAt).toBeNull();
    expect(s.priority).toBe("low");
    expect(s.attentionReason).toMatch(/turn/i);
  });

  it("marks the session ended only on SessionEnd and records endedAt", () => {
    const end = ev(fx.sessionEnd());
    const s = run([ev(fx.sessionStart()), ev(fx.stop()), end]);
    expect(s.status).toBe("ended");
    expect(s.priority).toBe("none");
    expect(s.endedAt).toBe(end.receivedAt);
  });

  it("keeps ended sticky for delayed events but allows a new SessionStart to reopen", () => {
    const ended = run([ev(fx.sessionStart()), ev(fx.sessionEnd())]);
    const afterLate = reduceSession(ended, ev(fx.postToolUse()));
    expect(afterLate.status).toBe("ended");
    expect(afterLate.lastEventType).toBe("tool_end");
    const reopened = reduceSession(afterLate, ev({ ...fx.sessionStart(), source: "resume" }));
    expect(reopened.status).toBe("starting");
    expect(reopened.endedAt).toBeNull();
  });

  it("does not let a delayed tool end flip a completed turn back to working", () => {
    const s = run([ev(fx.sessionStart()), ev(fx.preToolUse()), ev(fx.stop()), ev(fx.postToolUse())]);
    expect(s.status).toBe("completed");
  });

  it("does not change status on SubagentStop or PreCompact", () => {
    const base = run([ev(fx.sessionStart()), ev(fx.preToolUse())]);
    expect(reduceSession(base, ev(fx.subagentStop())).status).toBe("working");
    expect(reduceSession(base, ev({ ...fx.sessionStart(), hook_event_name: "PreCompact", trigger: "auto" })).status).toBe("working");
  });

  it("always advances lastSeenAt and lastEventType", () => {
    const a = ev(fx.sessionStart());
    const b = ev(fx.subagentStop());
    const s = run([a, b]);
    expect(s.lastSeenAt).toBe(b.receivedAt);
    expect(s.lastEventType).toBe("subagent_stop");
  });
});

describe("reduceSession: attention rules", () => {
  it("flags a permission request as needs_attention with high priority and the tool name", () => {
    const s = run([ev(fx.sessionStart(fx.SESSION_B)), ev(fx.preToolUse(fx.SESSION_B)), ev(fx.permissionRequest())]);
    expect(s.status).toBe("needs_attention");
    expect(s.priority).toBe("high");
    expect(s.attentionReason).toContain("Bash");
    expect(s.classificationSource).toBe("rule");
    expect(s.classificationConfidence).toBeNull();
    expect(s.pendingPermissionToolUseId).toBe("toolu_01HNJhjMNUijyBRhiiwRiBJC");
  });

  it("treats a permission_prompt notification as the same interruption", () => {
    const s = run([ev(fx.sessionStart(fx.SESSION_B)), ev(fx.permissionRequest()), ev(fx.permissionNotification())]);
    expect(s.status).toBe("needs_attention");
    expect(s.priority).toBe("high");
    expect(s.attentionReason).toContain("Bash");
  });

  it("flags a permission_prompt notification on its own when no PermissionRequest was seen", () => {
    const s = run([ev(fx.sessionStart(fx.SESSION_B)), ev(fx.permissionNotification())]);
    expect(s.status).toBe("needs_attention");
    expect(s.priority).toBe("high");
  });

  it("resolves a permission request when the tool runs, a new tool starts, a prompt arrives or the turn ends", () => {
    const base = run([ev(fx.sessionStart(fx.SESSION_B)), ev(fx.preToolUse(fx.SESSION_B)), ev(fx.permissionRequest())]);
    const resolvedByTool = reduceSession(base, ev(fx.postToolUse(fx.SESSION_B, "toolu_01HNJhjMNUijyBRhiiwRiBJC")));
    expect(resolvedByTool.status).toBe("working");
    expect(resolvedByTool.priority).toBe("none");
    expect(resolvedByTool.pendingPermissionToolUseId).toBeNull();
    expect(reduceSession(base, ev(fx.preToolUse(fx.SESSION_B, "toolu_next"))).status).toBe("working");
    expect(reduceSession(base, ev(fx.userPromptSubmit(fx.SESSION_B))).status).toBe("working");
    const stopped = reduceSession(base, ev(fx.stop(fx.SESSION_B)));
    expect(stopped.status).toBe("completed");
    expect(stopped.priority).toBe("low");
  });

  it("keeps a pending permission when a different tool finishes or fails", () => {
    const base = run([ev(fx.sessionStart(fx.SESSION_B)), ev(fx.preToolUse(fx.SESSION_B, "A")), ev(fx.preToolUse(fx.SESSION_B, "B")), ev(fx.permissionRequest(fx.SESSION_B, "B"))]);
    const afterOtherEnd = reduceSession(base, ev(fx.postToolUse(fx.SESSION_B, "A")));
    expect(afterOtherEnd.status).toBe("needs_attention");
    expect(afterOtherEnd.priority).toBe("high");
    expect(afterOtherEnd.pendingPermissionToolUseId).toBe("B");
    const afterOtherFailure = reduceSession(base, ev(fx.postToolUseFailure(fx.SESSION_B, "A")));
    expect(afterOtherFailure.status).toBe("needs_attention");
    expect(afterOtherFailure.recentFailureTimes).toHaveLength(1);
    expect(reduceSession(base, ev(fx.postToolUse(fx.SESSION_B, "B"))).status).toBe("working");
  });

  it("does not let an unknown notification demote a pending permission", () => {
    const base = run([ev(fx.sessionStart(fx.SESSION_B)), ev(fx.permissionRequest())]);
    const s = reduceSession(base, ev(fx.unknownNotification()));
    expect(s.status).toBe("needs_attention");
    expect(s.priority).toBe("high");
    expect(s.pendingPermissionToolUseId).toBe("toolu_01HNJhjMNUijyBRhiiwRiBJC");
    expect(s.attentionReason).toContain("Bash");
  });

  it("treats a compaction restart as a no-op and keeps the first start time on resume", () => {
    const first = ev(fx.sessionStart());
    const base = run([first, ev(fx.preToolUse()), ev(fx.permissionRequest(fx.SESSION_A))]);
    const afterCompact = reduceSession(base, ev({ ...fx.sessionStart(), source: "compact" }));
    expect(afterCompact.status).toBe("needs_attention");
    expect(afterCompact.startedAt).toBe(first.receivedAt);
    const afterResume = reduceSession(base, ev({ ...fx.sessionStart(), source: "resume" }));
    expect(afterResume.status).toBe("starting");
    expect(afterResume.startedAt).toBe(first.receivedAt);
  });

  it("marks an idle_prompt notification as waiting for input with medium priority", () => {
    const s = run([ev(fx.sessionStart(fx.SESSION_B)), ev(fx.stop(fx.SESSION_B)), ev(fx.idleNotification())]);
    expect(s.status).toBe("needs_attention");
    expect(s.priority).toBe("medium");
    expect(s.classificationSource).toBe("rule");
  });

  it("gives an unknown notification a fallback medium placeholder until classified", () => {
    const s = run([ev(fx.sessionStart(fx.SESSION_B)), ev(fx.unknownNotification())]);
    expect(s.priority).toBe("medium");
    expect(s.classificationSource).toBe("fallback");
    expect(s.attentionReason).toMatch(/unclassified/i);
  });

  it("marks a tool failure as error with low priority and escalates repeated failures", () => {
    const one = run([ev(fx.sessionStart()), ev(fx.postToolUseFailure())]);
    expect(one.status).toBe("error");
    expect(one.priority).toBe("low");
    expect(one.attentionReason).toContain("Bash");
    const three = run([
      ev(fx.sessionStart()),
      ev(fx.postToolUseFailure(fx.SESSION_A, "t1")),
      ev(fx.postToolUseFailure(fx.SESSION_A, "t2"), 5_000),
      ev(fx.postToolUseFailure(fx.SESSION_A, "t3"), 5_000),
    ]);
    expect(three.status).toBe("error");
    expect(three.priority).toBe("medium");
    expect(three.attentionReason).toMatch(/3 .*fail/i);
  });

  it("forgets failures older than the escalation window", () => {
    const s = run([
      ev(fx.sessionStart()),
      ev(fx.postToolUseFailure(fx.SESSION_A, "t1")),
      ev(fx.postToolUseFailure(fx.SESSION_A, "t2"), 10 * 60_000),
      ev(fx.postToolUseFailure(fx.SESSION_A, "t3"), 10 * 60_000),
    ]);
    expect(s.priority).toBe("low");
  });

  it("treats an interrupted tool as the user having stopped the agent, not as an error", () => {
    const s = run([ev(fx.sessionStart()), ev({ ...fx.postToolUseFailure(), is_interrupt: true })]);
    expect(s.status).toBe("idle");
    expect(s.priority).toBe("low");
  });

  it("recovers from error when work continues", () => {
    const s = run([ev(fx.sessionStart()), ev(fx.postToolUseFailure()), ev(fx.preToolUse())]);
    expect(s.status).toBe("working");
    expect(s.priority).toBe("none");
    expect(s.attentionReason).toBeNull();
  });

  it("flags a completed turn whose last message looks like a question as medium", () => {
    const s = run([ev(fx.sessionStart()), ev(fx.stop(fx.SESSION_A, "Should I also delete the old migrations?"))]);
    expect(s.status).toBe("completed");
    expect(s.priority).toBe("medium");
    expect(s.attentionReason).toMatch(/question/i);
  });
});

describe("task severity", () => {
  const ddlPrompt = () => ({ ...fx.userPromptSubmit(), prompt: "Drop the legacy_users table and rewrite the migration" });
  const docsPrompt = () => ({ ...fx.userPromptSubmit(), prompt: "Fix the typo in the README" });

  it("starts with no task context", () => {
    const s = reduceSession(null, ev(fx.sessionStart()));
    expect(s.taskSummary).toBeNull();
    expect(s.taskSeverity).toBe("none");
    expect(s.recentActions).toEqual([]);
  });

  it("sets the task summary and keyword severity on a prompt and resets previous context", () => {
    const s = run([ev(fx.sessionStart()), ev(ddlPrompt())]);
    expect(s.taskSummary).toBe("Drop the legacy_users table and rewrite the migration");
    expect(s.taskSeverity).toBe("critical");
    expect(s.taskRuleSeverity).toBe("critical");
    expect(s.taskSeveritySource).toBe("rule");
    expect(s.taskSeverityReason).toMatch(/Matched/);
    const next = reduceSession({ ...s, recentActions: ["Bash: x"], lastNarration: "y" }, ev(docsPrompt()));
    expect(next.taskSeverity).toBe("low");
    expect(next.recentActions).toEqual([]);
    expect(next.lastNarration).toBeNull();
  });

  it("records recent actions and raises severity from risky commands", () => {
    const base = run([ev(fx.sessionStart()), ev(docsPrompt())]);
    const after = run([
      ev({ ...fx.preToolUse(fx.SESSION_A, "t1"), tool_input: { command: "cat README.md" } }),
      ev({ ...fx.preToolUse(fx.SESSION_A, "t2"), tool_input: { command: "git push origin main --force" } }),
    ], base);
    expect(after.recentActions).toEqual(["Bash: cat README.md", "Bash: git push origin main --force"]);
    expect(after.taskSeverity).toBe("critical");
    expect(after.taskSeverityReason).toContain("--force");
  });

  it("keeps at most five recent actions", () => {
    let s = run([ev(fx.sessionStart()), ev(docsPrompt())]);
    for (let i = 0; i < 8; i++) s = reduceSession(s, ev({ ...fx.preToolUse(fx.SESSION_A, `t${i}`), tool_input: { command: `echo ${i}` } }));
    expect(s.recentActions).toHaveLength(5);
    expect(s.recentActions[4]).toBe("Bash: echo 7");
  });

  it("records the assistant narration and raises severity from it", () => {
    const s = run([ev(fx.sessionStart()), ev(docsPrompt()), ev(fx.stop(fx.SESSION_A, "Next I will run terraform apply for the cluster."))]);
    expect(s.lastNarration).toContain("terraform apply");
    expect(s.taskSeverity).toBe("critical");
  });

  it("escalates a permission request to critical attention when the command or task is critical-risk", () => {
    const risky = run([ev(fx.sessionStart(fx.SESSION_B)), ev({ ...fx.permissionRequest(), tool_input: { command: "psql -c 'DROP TABLE legacy_users'" } })]);
    expect(risky.status).toBe("needs_attention");
    expect(risky.priority).toBe("critical");
    expect(risky.attentionReason).toContain("DROP TABLE");
    const plain = run([ev(fx.sessionStart(fx.SESSION_B)), ev({ ...fx.permissionRequest(), tool_input: { command: "touch probe-file.txt" } })]);
    expect(plain.priority).toBe("high");
    const criticalTask = run([ev(fx.sessionStart(fx.SESSION_B)), ev({ ...fx.userPromptSubmit(fx.SESSION_B), prompt: "deploy the api to production" }), ev({ ...fx.permissionRequest(), tool_input: { command: "pnpm run deploy" } })]);
    expect(criticalTask.priority).toBe("critical");
  });

  it("does not let a session restart wipe the task context", () => {
    const s = run([ev(fx.sessionStart()), ev(ddlPrompt()), ev({ ...fx.sessionStart(), source: "resume" })]);
    expect(s.taskSummary).toContain("legacy_users");
    expect(s.taskSeverity).toBe("critical");
  });

  it("asks the model to rate the task on prompts and finished turns only", () => {
    const start = ev(fx.sessionStart());
    const s0 = reduceSession(null, start);
    expect(shouldClassifyTask(s0, start)).toBe(false);
    const p = ev(docsPrompt());
    const s1 = reduceSession(s0, p);
    expect(shouldClassifyTask(s1, p)).toBe(true);
    const t = ev({ ...fx.preToolUse(), tool_input: { command: "ls" } });
    expect(shouldClassifyTask(reduceSession(s1, t), t)).toBe(false);
    const stop = ev(fx.stop(fx.SESSION_A, "Done, I updated the README."));
    expect(shouldClassifyTask(reduceSession(s1, stop), stop)).toBe(true);
    const end = ev(fx.sessionEnd());
    expect(shouldClassifyTask(reduceSession(s1, end), end)).toBe(false);
  });

  it("applies a model severity above the keyword floor but never below it", () => {
    const p = ev({ ...fx.userPromptSubmit(), prompt: "rewrite the authentication middleware" });
    const s = run([ev(fx.sessionStart()), p]);
    expect(s.taskSeverity).toBe("high");
    const raised = applyTaskClassification(s, p, { needs_attention: true, priority: "critical", reason: "Touches login for all users.", evidence: ["authentication"], confidence: 0.7 }, "2026-10-09T09:00:00.000Z", s.eventSeq);
    expect(raised.taskSeverity).toBe("critical");
    expect(raised.taskSeveritySource).toBe("ai");
    expect(raised.taskSeverityReason).toBe("Touches login for all users.");
    expect(raised.taskSeverityConfidence).toBe(0.7);
    expect(raised.taskRuleSeverity).toBe("high");
    const lowered = applyTaskClassification(s, p, { needs_attention: false, priority: "none", reason: "Trivial.", evidence: [], confidence: 0.9 }, "2026-10-09T09:00:00.000Z", s.eventSeq);
    expect(lowered.taskSeverity).toBe("high");
    expect(lowered.taskSeveritySource).toBe("ai");
    const stale = applyTaskClassification(s, p, { needs_attention: true, priority: "critical", reason: "x", evidence: [], confidence: 0.9 }, "2026-10-09T09:00:00.000Z", s.eventSeq - 1);
    expect(stale).toBe(s);
  });

  it("sorts by task severity after attention priority", () => {
    const now = Date.parse("2026-10-09T10:00:00.000Z");
    const t = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
    const base = reduceSession(null, ev(fx.sessionStart()));
    const mk = (id: string, over: Partial<Session>): Session => ({ ...base, sessionId: id, ...over });
    const ids = sortSessions([
      mk("working-low", { status: "working", priority: "none", taskSeverity: "low", lastSeenAt: t(1) }),
      mk("working-critical", { status: "working", priority: "none", taskSeverity: "critical", lastSeenAt: t(5) }),
      mk("attention", { status: "needs_attention", priority: "high", taskSeverity: "none", lastSeenAt: t(9) }),
    ], now, 600_000).map((s) => s.sessionId);
    expect(ids).toEqual(["attention", "working-critical", "working-low"]);
  });
});

describe("shouldClassify", () => {
  it("never asks the model for routine or unambiguous events", () => {
    const routine = [fx.sessionStart(), fx.userPromptSubmit(), fx.preToolUse(), fx.postToolUse(), fx.permissionRequest(), fx.permissionNotification(), fx.idleNotification(), fx.subagentStop(), fx.sessionEnd(), fx.stop(fx.SESSION_A, "DONE")];
    for (const raw of routine) {
      const e = ev(raw);
      const s = reduceSession(null, e);
      expect(shouldClassify(s, e), `${e.type} should not classify`).toBe(false);
    }
  });

  it("asks the model for unknown notifications, failures with text, and question-like turn ends", () => {
    for (const raw of [fx.unknownNotification(), fx.postToolUseFailure(), fx.stop(fx.SESSION_A, "Which approach do you prefer?")]) {
      const e = ev(raw);
      const s = reduceSession(null, e);
      expect(shouldClassify(s, e), `${e.type} should classify`).toBe(true);
    }
  });

  it("never asks the model about an ended session", () => {
    const e = ev(fx.unknownNotification());
    const ended = reduceSession(reduceSession(null, ev(fx.sessionEnd(fx.SESSION_B))), e);
    expect(shouldClassify(ended, e)).toBe(false);
  });
});

describe("applyClassification", () => {
  const at = "2026-10-09T09:00:00.000Z";

  it("records an AI classification with reason, evidence, confidence and timestamp", () => {
    const e = ev(fx.unknownNotification());
    const s = reduceSession(null, e);
    const out = applyClassification(s, e, {
      needs_attention: true,
      priority: "high",
      reason: "The session hit a rate limit and is retrying.",
      evidence: ["Rate limit reached"],
      confidence: 0.8,
    }, at);
    expect(out.priority).toBe("high");
    expect(out.classificationSource).toBe("ai");
    expect(out.classificationConfidence).toBe(0.8);
    expect(out.classifiedAt).toBe(at);
    expect(out.classificationEvidence).toEqual(["Rate limit reached"]);
    expect(out.attentionReason).toContain("rate limit");
    expect(out.status).toBe(s.status);
  });

  it("lets the model lower a fallback placeholder to none", () => {
    const e = ev(fx.unknownNotification());
    const out = applyClassification(reduceSession(null, e), e, {
      needs_attention: false, priority: "none", reason: "Routine progress.", evidence: [], confidence: 0.9,
    }, at);
    expect(out.priority).toBe("none");
  });

  it("never lowers the priority below the deterministic floor of the triggering event", () => {
    const e = ev(fx.postToolUseFailure());
    const out = applyClassification(reduceSession(null, e), e, {
      needs_attention: false, priority: "none", reason: "Harmless.", evidence: [], confidence: 0.9,
    }, at);
    expect(out.priority).toBe("low");
    expect(out.status).toBe("error");
  });

  it("only accepts critical when the session is in error or needs_attention", () => {
    const e = ev(fx.stop(fx.SESSION_A, "Can I proceed?"));
    const out = applyClassification(reduceSession(null, e), e, {
      needs_attention: true, priority: "critical", reason: "Asks a question.", evidence: [], confidence: 0.9,
    }, at);
    expect(out.priority).toBe("high");
  });

  it("is ignored when a same-type event arrived in the same millisecond", () => {
    const first = ev(fx.unknownNotification(fx.SESSION_B, "first"));
    const second = ev(fx.unknownNotification(fx.SESSION_B, "second"), 0);
    const afterFirst = reduceSession(null, first);
    const s = reduceSession(afterFirst, second);
    const out = applyClassification(s, first, { needs_attention: true, priority: "high", reason: "x", evidence: [], confidence: 0.9 }, at, afterFirst.eventSeq);
    expect(out).toBe(s);
    const applied = applyClassification(s, second, { needs_attention: true, priority: "high", reason: "x", evidence: [], confidence: 0.9 }, at, s.eventSeq);
    expect(applied.classificationSource).toBe("ai");
  });

  it("is ignored when the session has moved on since the triggering event", () => {
    const trigger = ev(fx.unknownNotification());
    const moved = run([trigger, ev(fx.userPromptSubmit(fx.SESSION_B))]);
    const out = applyClassification(moved, trigger, {
      needs_attention: true, priority: "high", reason: "x", evidence: [], confidence: 0.9,
    }, at);
    expect(out).toBe(moved);
  });

  it("is ignored for ended sessions", () => {
    const trigger = ev(fx.unknownNotification());
    const ended = run([trigger, ev(fx.sessionEnd(fx.SESSION_B))]);
    const out = applyClassification(ended, trigger, {
      needs_attention: true, priority: "critical", reason: "x", evidence: [], confidence: 1,
    }, at);
    expect(out.status).toBe("ended");
    expect(out.priority).toBe("none");
  });
});

describe("isStale and sortSessions", () => {
  const mk = (over: Partial<Session>): Session => ({
    ...reduceSession(null, ev(fx.sessionStart(over.sessionId ?? fx.SESSION_A))),
    ...over,
  });

  it("flags sessions with no events past the threshold, except ended ones", () => {
    const now = Date.parse("2026-10-09T10:00:00.000Z");
    const old = new Date(now - 11 * 60_000).toISOString();
    expect(isStale(mk({ lastSeenAt: old }), now, 10 * 60_000)).toBe(true);
    expect(isStale(mk({ lastSeenAt: new Date(now - 60_000).toISOString() }), now, 10 * 60_000)).toBe(false);
    expect(isStale(mk({ lastSeenAt: old, status: "ended", endedAt: old }), now, 10 * 60_000)).toBe(false);
  });

  it("orders active before ended, then by priority, then fresh before stale, then recency", () => {
    const now = Date.parse("2026-10-09T10:00:00.000Z");
    const t = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
    const sessions = [
      mk({ sessionId: "ended-high", status: "ended", endedAt: t(1), priority: "none", lastSeenAt: t(1) }),
      mk({ sessionId: "low-fresh", priority: "low", lastSeenAt: t(2) }),
      mk({ sessionId: "high-stale", priority: "high", lastSeenAt: t(30) }),
      mk({ sessionId: "high-fresh-old", priority: "high", lastSeenAt: t(5) }),
      mk({ sessionId: "high-fresh-new", priority: "high", lastSeenAt: t(1) }),
      mk({ sessionId: "critical", priority: "critical", lastSeenAt: t(3) }),
    ];
    const ids = sortSessions(sessions, now, 10 * 60_000).map((s) => s.sessionId);
    expect(ids).toEqual(["critical", "high-fresh-new", "high-fresh-old", "high-stale", "low-fresh", "ended-high"]);
  });
});
