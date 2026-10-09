import { describe, expect, it } from "vitest";
import { normalizeHookEvent, sanitizeText } from "@/core/events/normalize";
import * as fx from "./fixtures/hook-events";

const RECEIVED_AT = "2026-10-09T08:00:00.000Z";

function normalize(raw: unknown) {
  return normalizeHookEvent(raw, RECEIVED_AT);
}

describe("normalizeHookEvent", () => {
  it("maps each supported hook to a normalized event type", () => {
    const cases: Array<[unknown, string]> = [
      [fx.sessionStart(), "session_start"],
      [fx.userPromptSubmit(), "prompt"],
      [fx.preToolUse(), "tool_start"],
      [fx.postToolUse(), "tool_end"],
      [fx.postToolUseFailure(), "tool_failure"],
      [fx.permissionRequest(), "permission_request"],
      [fx.permissionNotification(), "notification"],
      [fx.stop(), "turn_complete"],
      [fx.subagentStop(), "subagent_stop"],
      [fx.sessionEnd(), "session_end"],
    ];
    for (const [raw, type] of cases) {
      const result = normalize(raw);
      expect(result.ok, `expected ${type} to normalize`).toBe(true);
      if (result.ok) expect(result.event.type).toBe(type);
    }
  });

  it("carries session id, receivedAt and a label derived from the cwd basename only", () => {
    const result = normalize(fx.preToolUse());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.sessionId).toBe(fx.SESSION_A);
    expect(result.event.receivedAt).toBe(RECEIVED_AT);
    expect(result.event.label).toBe("my-app");
  });

  it("rejects unsupported hook events without throwing", () => {
    const result = normalize(fx.instructionsLoaded());
    expect(result).toEqual({ ok: false, reason: "unsupported_event" });
  });

  it("rejects payloads without a usable session id", () => {
    expect(normalize({ ...fx.sessionStart(), session_id: undefined })).toEqual({ ok: false, reason: "invalid_payload" });
    expect(normalize({ ...fx.sessionStart(), session_id: "../../etc" })).toEqual({ ok: false, reason: "invalid_payload" });
    expect(normalize({ ...fx.sessionStart(), session_id: "x".repeat(200) })).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("rejects non-object and malformed payloads", () => {
    expect(normalize(null).ok).toBe(false);
    expect(normalize("string").ok).toBe(false);
    expect(normalize([]).ok).toBe(false);
    expect(normalize({ hook_event_name: 42 }).ok).toBe(false);
  });

  it("keeps prompt text and tool input out of the stored summary and paths out of everything", () => {
    const prompt = normalize(fx.userPromptSubmit());
    const tool = normalize(fx.preToolUse());
    expect(prompt.ok && prompt.event.summary).toBe("Prompt submitted");
    expect(tool.ok && tool.event.summary).toBe("Running Bash");
    for (const r of [prompt, tool]) {
      if (!r.ok) continue;
      expect(r.event.summary).not.toContain("node hello.js");
      expect(JSON.stringify(r.event)).not.toContain("/home/dev");
      expect(r.event.classifierText).toBeNull();
    }
  });

  it("summarises failures with the tool name and a sanitized first error line", () => {
    const result = normalize(fx.postToolUseFailure());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.toolName).toBe("Bash");
    expect(result.event.summary).toBe("Bash failed: Exit code 1");
    expect(result.event.classifierText).toContain("No such file or directory");
    expect(result.event.isInterrupt).toBe(false);
  });

  it("marks interrupted tool failures", () => {
    const result = normalize({ ...fx.postToolUseFailure(), is_interrupt: true });
    expect(result.ok && result.event.isInterrupt).toBe(true);
  });

  it("keeps the tool name and tool use id for permission requests", () => {
    const result = normalize(fx.permissionRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.toolName).toBe("Bash");
    expect(result.event.toolUseId).toBe("toolu_01HNJhjMNUijyBRhiiwRiBJC");
    expect(result.event.summary).toBe("Permission requested for Bash");
    expect(result.event.taskText).toBe("Bash: touch probe-file.txt");
  });

  it("keeps the notification type and a bounded message", () => {
    const long = "x".repeat(2000);
    const result = normalize(fx.unknownNotification(fx.SESSION_B, long));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.notificationType).toBe("custom_type");
    expect(result.event.summary!.length).toBeLessThanOrEqual(160);
    expect(result.event.classifierText!.length).toBeLessThanOrEqual(400);
  });

  it("exposes the assistant's last message to the classifier but not in the summary", () => {
    const result = normalize(fx.stop(fx.SESSION_A, "Should I delete the old migrations?"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.summary).toBe("Turn finished");
    expect(result.event.classifierText).toBe("Should I delete the old migrations?");
  });

  it("gives distinct dedupe keys to turn ends and prompts of different turns", () => {
    const a = normalize({ ...fx.stop(), prompt_id: "p1" });
    const b = normalize({ ...fx.stop(), prompt_id: "p2" });
    const c = normalize({ ...fx.stop(fx.SESSION_A, "other answer"), prompt_id: "p1" });
    const p1 = normalize({ ...fx.userPromptSubmit(), prompt_id: "p1" });
    const p2 = normalize({ ...fx.userPromptSubmit(), prompt_id: "p2" });
    expect(a.ok && b.ok && a.event.dedupeKey).not.toBe(b.ok && b.event.dedupeKey);
    expect(a.ok && c.ok && a.event.dedupeKey).not.toBe(c.ok && c.event.dedupeKey);
    expect(p1.ok && p2.ok && p1.event.dedupeKey).not.toBe(p2.ok && p2.event.dedupeKey);
  });

  it("marks subagent stops and compactions as exempt from deduplication", () => {
    const sub = normalize(fx.subagentStop());
    expect(sub.ok && sub.event.dedupeKey).toBeNull();
  });

  it("keeps long MCP tool names and tool ids intact", () => {
    const r = normalize({ ...fx.permissionRequest(), tool_name: "mcp__linear-server__create_attachment_from_upload", tool_use_id: "toolu_" + "a".repeat(50) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.toolName).toBe("mcp__linear-server__create_attachment_from_upload");
    expect(r.event.toolUseId).toBe("toolu_" + "a".repeat(50));
    expect(r.event.summary).toContain("mcp__linear-server__create_attachment_from_upload");
  });

  it("truncates oversized free-text fields instead of rejecting the event", () => {
    const r = normalize({ ...fx.stop(fx.SESSION_A, "x".repeat(200_000)) });
    expect(r.ok).toBe(true);
    const f = normalize({ ...fx.postToolUseFailure(), error: "boom ".repeat(50_000) });
    expect(f.ok && f.event.classifierText!.length).toBeLessThanOrEqual(400);
  });

  it("carries the session start source", () => {
    const r = normalize({ ...fx.sessionStart(), source: "compact" });
    expect(r.ok && r.event.source).toBe("compact");
  });

  it("extracts task context from prompts, tool inputs and assistant messages", () => {
    const prompt = normalize({ ...fx.userPromptSubmit(), prompt: "Drop the legacy_users table and rewrite the migration" });
    expect(prompt.ok && prompt.event.taskKind).toBe("prompt");
    expect(prompt.ok && prompt.event.taskText).toBe("Drop the legacy_users table and rewrite the migration");
    expect(prompt.ok && prompt.event.riskHits[0]!.level).toBe("critical");

    const bash = normalize({ ...fx.permissionRequest(), tool_input: { command: "psql -c 'DROP TABLE legacy_users'", description: "Drop table" } });
    expect(bash.ok && bash.event.taskKind).toBe("action");
    expect(bash.ok && bash.event.taskText).toBe("Bash: psql -c 'DROP TABLE legacy_users'");
    expect(bash.ok && bash.event.riskHits[0]!.level).toBe("critical");

    const write = normalize({ ...fx.preToolUse(), tool_name: "Write", tool_input: { file_path: "/home/dev/Projects/my-app/src/db/migrate.ts", content: "SECRET" } });
    expect(write.ok && write.event.taskText).toBe("Write: src/db/migrate.ts");
    expect(JSON.stringify(write)).not.toContain("SECRET");

    const stop = normalize(fx.stop(fx.SESSION_A, "I will now run the migration against production."));
    expect(stop.ok && stop.event.taskKind).toBe("narration");
    expect(stop.ok && stop.event.riskHits[0]!.level).toBe("critical");

    const start = normalize(fx.sessionStart());
    expect(start.ok && start.event.taskKind).toBeNull();
  });

  it("bounds and redacts task text", () => {
    const r = normalize({ ...fx.userPromptSubmit(), prompt: "token=abcdefghijklmnop " + "x".repeat(1000) });
    expect(r.ok && r.event.taskText!.length).toBeLessThanOrEqual(300);
    expect(r.ok && r.event.taskText).toContain("[redacted]");
    expect(r.ok && r.event.summary).toBe("Prompt submitted");
  });

  it("produces identical dedupe keys for identical events and different keys otherwise", () => {
    const a = normalize(fx.permissionRequest());
    const b = normalize(fx.permissionRequest());
    const c = normalize(fx.permissionRequest(fx.SESSION_B, "toolu_other"));
    const d = normalize(fx.permissionRequest(fx.SESSION_A));
    expect(a.ok && b.ok && a.event.dedupeKey).toBe(b.ok && b.event.dedupeKey);
    expect(a.ok && c.ok && a.event.dedupeKey).not.toBe(c.ok && c.event.dedupeKey);
    expect(a.ok && d.ok && a.event.dedupeKey).not.toBe(d.ok && d.event.dedupeKey);
  });
});

describe("sanitizeText", () => {
  it("strips ANSI escapes and control characters and collapses whitespace", () => {
    expect(sanitizeText("\u001b[31mred\u001b[0m\n\n  text\t\u0000here", 100)).toBe("red text here");
  });

  it("removes bidi overrides, zero-width and BOM characters", () => {
    expect(sanitizeText("Permission\u202eDELETED\u202c needed\u200b now\ufeff", 100)).toBe("PermissionDELETED needed now");
  });

  it("truncates to the given length", () => {
    expect(sanitizeText("a".repeat(50), 10)).toHaveLength(10);
  });

  it("redacts strings that look like secrets", () => {
    const out = sanitizeText("token sk-abcdefghijklmnopqrstuvwxyz0123456789 and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234", 200);
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234");
    expect(out).toContain("[redacted]");
  });

  it("returns an empty string for empty input", () => {
    expect(sanitizeText("", 10)).toBe("");
    expect(sanitizeText(undefined, 10)).toBe("");
  });
});
