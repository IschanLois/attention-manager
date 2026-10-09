import { z } from "zod";

export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

export const SUPPORTED_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionEnd",
] as const;

export type HookEventName = (typeof SUPPORTED_HOOK_EVENTS)[number];

const boundedString = (max: number) => z.string().max(max);
const truncatedString = (max: number) => z.preprocess((v) => (typeof v === "string" && v.length > max ? v.slice(0, max) : v), z.string());

export const hookEventSchema = z.object({
  session_id: z.string().regex(SESSION_ID_PATTERN),
  hook_event_name: z.enum(SUPPORTED_HOOK_EVENTS),
  cwd: boundedString(4096).optional(),
  source: boundedString(64).optional(),
  reason: boundedString(64).optional(),
  prompt_id: boundedString(128).optional(),
  prompt: truncatedString(100_000).optional(),
  tool_name: boundedString(128).optional(),
  tool_use_id: boundedString(128).optional(),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  error: truncatedString(100_000).optional(),
  is_interrupt: z.boolean().optional(),
  message: boundedString(10_000).optional(),
  notification_type: boundedString(64).optional(),
  stop_hook_active: z.boolean().optional(),
  last_assistant_message: truncatedString(100_000).optional(),
  trigger: boundedString(64).optional(),
});

export type HookEvent = z.infer<typeof hookEventSchema>;

export const EVENT_TYPES = [
  "session_start",
  "prompt",
  "tool_start",
  "tool_end",
  "tool_failure",
  "permission_request",
  "notification",
  "turn_complete",
  "subagent_stop",
  "compact",
  "session_end",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const SESSION_STATUSES = [
  "starting",
  "working",
  "needs_attention",
  "error",
  "completed",
  "idle",
  "ended",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const PRIORITIES = ["critical", "high", "medium", "low", "none"] as const;

export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_RANK: Record<Priority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

export const CLASSIFICATION_SOURCES = ["rule", "ai", "fallback"] as const;

export type ClassificationSource = (typeof CLASSIFICATION_SOURCES)[number];

export const SUMMARY_MAX_LENGTH = 160;
export const CLASSIFIER_TEXT_MAX_LENGTH = 400;

export interface NormalizedEvent {
  sessionId: string;
  type: EventType;
  receivedAt: string;
  label: string | null;
  summary: string | null;
  dedupeKey: string | null;
  promptId: string | null;
  source: string | null;
  toolName: string | null;
  toolUseId: string | null;
  notificationType: string | null;
  isInterrupt: boolean;
  classifierText: string | null;
}

export interface Session {
  sessionId: string;
  label: string | null;
  startedAt: string | null;
  lastSeenAt: string;
  lastEventType: EventType | null;
  status: SessionStatus;
  priority: Priority;
  attentionReason: string | null;
  classificationConfidence: number | null;
  classificationSource: ClassificationSource;
  classifiedAt: string | null;
  classificationEvidence: string[];
  classificationError: string | null;
  endedAt: string | null;
  recentFailureTimes: string[];
  pendingPermissionToolUseId: string | null;
  eventSeq: number;
}

export interface StoredEvent {
  id: number;
  sessionId: string;
  eventType: EventType;
  receivedAt: string;
  summary: string | null;
  dedupeKey: string | null;
}

export const classificationSchema = z.object({
  needs_attention: z.boolean(),
  priority: z.enum(PRIORITIES),
  reason: z.string().max(160),
  evidence: z.array(z.string().max(120)).max(3),
  confidence: z.number().min(0).max(1),
});

export type Classification = z.infer<typeof classificationSchema>;

export const classificationJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["needs_attention", "priority", "reason", "evidence", "confidence"],
  properties: {
    needs_attention: { type: "boolean" },
    priority: { type: "string", enum: [...PRIORITIES] },
    reason: { type: "string", maxLength: 160 },
    evidence: { type: "array", maxItems: 3, items: { type: "string", maxLength: 120 } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;
