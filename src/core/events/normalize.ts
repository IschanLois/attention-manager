import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  CLASSIFIER_TEXT_MAX_LENGTH,
  hookEventSchema,
  SUMMARY_MAX_LENGTH,
  type EventType,
  type HookEvent,
  type HookEventName,
  type NormalizedEvent,
} from "../schemas.ts";

export type NormalizeResult =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; reason: "invalid_payload" | "unsupported_event" };

const EVENT_TYPE_BY_HOOK: Record<HookEventName, EventType> = {
  SessionStart: "session_start",
  UserPromptSubmit: "prompt",
  PreToolUse: "tool_start",
  PostToolUse: "tool_end",
  PostToolUseFailure: "tool_failure",
  PermissionRequest: "permission_request",
  Notification: "notification",
  Stop: "turn_complete",
  SubagentStop: "subagent_stop",
  PreCompact: "compact",
  SessionEnd: "session_end",
};

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const INVISIBLE_PATTERN = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const SECRET_PATTERNS = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:Bearer|token|secret|password|api[_-]?key)\s*[:=]\s*\S{8,}/gi,
  /\b[A-Za-z0-9_-]{40,}\b/g,
];

export function sanitizeText(input: string | null | undefined, maxLength: number): string {
  if (!input) return "";
  let text = input.replace(ANSI_PATTERN, "").replace(INVISIBLE_PATTERN, "").replace(CONTROL_PATTERN, " ");
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[redacted]");
  text = text.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function firstLine(text: string | undefined): string {
  return sanitizeText((text ?? "").split(/\r?\n/)[0], 100);
}

function toolLabel(event: HookEvent): string {
  return sanitizeText(event.tool_name, 64) || "tool";
}

function labelFromCwd(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const name = sanitizeText(basename(cwd), 64);
  return name || null;
}

function summarize(event: HookEvent, type: EventType): { summary: string; classifierText: string | null } {
  switch (type) {
    case "session_start":
      return { summary: `Session started (${sanitizeText(event.source, 32) || "unknown"})`, classifierText: null };
    case "prompt":
      return { summary: "Prompt submitted", classifierText: null };
    case "tool_start":
      return { summary: `Running ${toolLabel(event)}`, classifierText: null };
    case "tool_end":
      return { summary: `${toolLabel(event)} finished`, classifierText: null };
    case "tool_failure": {
      const head = firstLine(event.error);
      return {
        summary: head ? `${toolLabel(event)} failed: ${head}` : `${toolLabel(event)} failed`,
        classifierText: sanitizeText(event.error, CLASSIFIER_TEXT_MAX_LENGTH) || null,
      };
    }
    case "permission_request":
      return { summary: `Permission requested for ${toolLabel(event)}`, classifierText: null };
    case "notification": {
      const kind = sanitizeText(event.notification_type, 32) || "unknown";
      const message = sanitizeText(event.message, 100);
      return {
        summary: message ? `Notification (${kind}): ${message}` : `Notification (${kind})`,
        classifierText: sanitizeText(event.message, CLASSIFIER_TEXT_MAX_LENGTH) || null,
      };
    }
    case "turn_complete":
      return { summary: "Turn finished", classifierText: sanitizeText(event.last_assistant_message, CLASSIFIER_TEXT_MAX_LENGTH) || null };
    case "subagent_stop":
      return { summary: "Subagent finished", classifierText: null };
    case "compact":
      return { summary: "Context compacted", classifierText: null };
    case "session_end":
      return { summary: `Session ended (${sanitizeText(event.reason, 32) || "unknown"})`, classifierText: null };
  }
}

function dedupeKey(parts: Array<string | null>): string {
  return createHash("sha256").update(parts.map((p) => p ?? "").join("|")).digest("hex").slice(0, 32);
}

export function normalizeHookEvent(raw: unknown, receivedAt: string): NormalizeResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "invalid_payload" };
  const name = (raw as { hook_event_name?: unknown }).hook_event_name;
  if (typeof name !== "string") return { ok: false, reason: "invalid_payload" };
  if (!(name in EVENT_TYPE_BY_HOOK)) return { ok: false, reason: "unsupported_event" };

  const parsed = hookEventSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid_payload" };
  const event = parsed.data;
  const type = EVENT_TYPE_BY_HOOK[event.hook_event_name];
  const { summary, classifierText } = summarize(event, type);
  const toolName = event.tool_name ? sanitizeText(event.tool_name, 64) || null : null;
  const toolUseId = event.tool_use_id ? sanitizeText(event.tool_use_id, 128) || null : null;
  const notificationType = type === "notification" ? sanitizeText(event.notification_type, 32) || "unknown" : null;

  return {
    ok: true,
    event: {
      sessionId: event.session_id,
      type,
      receivedAt,
      label: labelFromCwd(event.cwd),
      summary: summary.slice(0, SUMMARY_MAX_LENGTH),
      dedupeKey: dedupeKey([event.session_id, type, toolUseId, notificationType, summary]),
      toolName,
      toolUseId,
      notificationType,
      isInterrupt: event.is_interrupt === true,
      classifierText,
    },
  };
}
