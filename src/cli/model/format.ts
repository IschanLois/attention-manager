import type { ClassificationSource } from "./types.ts";

const EVENT_LABELS: Record<string, string> = {
  session_start: "Session started",
  prompt: "Prompt submitted",
  tool_start: "Tool started",
  tool_end: "Tool finished",
  tool_failure: "Tool failed",
  permission_request: "Permission requested",
  notification: "Notification",
  turn_complete: "Turn complete",
  subagent_stop: "Subagent stopped",
  compact: "Context compacted",
  session_end: "Session ended",
};

export function relativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.floor((nowMs - then) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }
  return `${Math.floor(hours / 24)}d`;
}

export function relativeTimeAgo(iso: string, nowMs: number): string {
  const value = relativeTime(iso, nowMs);
  return value === "just now" || value === "unknown" ? value : `${value} ago`;
}

export function absoluteTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function humaniseEventType(type: string | null): string {
  if (!type) return "No events yet";
  const known = EVENT_LABELS[type];
  if (known) return known;
  const words = type.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function shortId(sessionId: string): string {
  return sessionId.slice(-4);
}

export function sessionLabel(label: string | null, sessionId: string): string {
  return label ?? `session …${shortId(sessionId)}`;
}

export function sourceLabel(source: ClassificationSource, confidence: number | null): string {
  if (source === "rule") return "Observed";
  if (source === "fallback") return "Observed · AI unavailable";
  return confidence === null ? "AI confidence unknown" : `AI confidence ${Math.round(confidence * 100)}%`;
}
