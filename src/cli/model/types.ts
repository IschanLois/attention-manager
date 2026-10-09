import type { ClassificationSource, EventType, Priority, SessionStatus, StoredEvent } from "../../core/schemas.ts";
import type { SessionDetail, SessionsSnapshot, SessionView } from "../../core/sessions/view.ts";
import type { HealthReport } from "../../receiver/server.ts";

export type { ClassificationSource, EventType, HealthReport, Priority, SessionDetail, SessionsSnapshot, SessionStatus, SessionView, StoredEvent };

export type ConnectionState = "live" | "reconnecting" | "offline";

export type SortMode = "attention" | "recent" | "label";

export interface Filters {
  statuses: SessionStatus[];
  priorities: Priority[];
  risks: Priority[];
  hideEnded: boolean;
  sort: SortMode;
  label: string;
}

export const STATUS_VALUES: readonly SessionStatus[] = ["needs_attention", "error", "working", "starting", "completed", "idle", "ended"];
export const PRIORITY_VALUES: readonly Priority[] = ["critical", "high", "medium", "low", "none"];
export const SORT_MODES: readonly SortMode[] = ["attention", "recent", "label"];

export const STATUS_LABELS: Record<SessionStatus, string> = {
  starting: "Starting",
  working: "Working",
  needs_attention: "Needs input",
  error: "Error",
  completed: "Turn complete",
  idle: "Idle / unknown",
  ended: "Ended",
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  critical: "CRITICAL",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
  none: "None",
};

export const RISK_LABELS: Record<Priority, string> = {
  critical: "Critical risk",
  high: "High risk",
  medium: "Medium risk",
  low: "Low risk",
  none: "No risk",
};
