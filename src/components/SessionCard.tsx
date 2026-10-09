"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import { humaniseEventType, relativeTimeAgo, sessionLabel, shortId } from "@/lib/format";
import type { SessionView } from "@/lib/types";
import { PriorityBadge, RelativeTime, SourceBadge, StatusPill } from "./badges";
import { ClockIcon } from "./icons";

export interface SessionCardProps {
  session: SessionView;
  isStale: boolean;
  isSelected: boolean;
  isFocusable: boolean;
  nowMs: number;
  updatedAt: number | undefined;
  compact?: boolean;
  onSelect: (sessionId: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLLIElement>) => void;
  cardRef: (node: HTMLLIElement | null) => void;
}

const BORDER_BY_PRIORITY: Record<SessionView["priority"], string> = {
  critical: "border-l-red-500 bg-red-50 dark:bg-red-500/10",
  high: "border-l-amber-500 bg-amber-50 dark:bg-amber-500/10",
  medium: "border-l-yellow-500",
  low: "border-l-blue-500",
  none: "border-l-zinc-300 dark:border-l-zinc-700",
};

function useTransientClass(node: React.RefObject<HTMLLIElement | null>, className: string, trigger: unknown, durationMs: number, skipFirst = true) {
  const first = useRef(skipFirst);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (trigger === undefined || trigger === false) return;
    const element = node.current;
    if (!element) return;
    element.classList.add(className);
    const timer = setTimeout(() => element.classList.remove(className), durationMs);
    return () => {
      clearTimeout(timer);
      element.classList.remove(className);
    };
  }, [node, className, trigger, durationMs]);
}

export function SessionCard({
  session,
  isStale,
  isSelected,
  isFocusable,
  nowMs,
  updatedAt,
  compact = false,
  onSelect,
  onKeyDown,
  cardRef,
}: SessionCardProps) {
  const node = useRef<HTMLLIElement | null>(null);
  useTransientClass(node, "am-flash", updatedAt, 600);
  useTransientClass(node, "am-attention-pulse", session.status === "needs_attention", 1_500);
  const dominant = !compact && (session.priority === "critical" || session.priority === "high");
  const label = sessionLabel(session.label, session.sessionId);
  const reason =
    session.classificationSource === "fallback" && !session.attentionReason
      ? "Contextual classification unavailable; showing rule-based state."
      : session.attentionReason;

  const classes = [
    "relative list-none rounded-md border border-edge border-l-4 bg-card px-3 py-2 cursor-pointer outline-none transition-colors",
    "focus-visible:ring-2 focus-visible:ring-blue-500",
    BORDER_BY_PRIORITY[session.priority],
    isSelected ? "ring-2 ring-blue-500" : "",
    isStale ? "[border-left-color:color-mix(in_srgb,currentColor_40%,transparent)]" : "",
    compact ? "opacity-60 py-1.5" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li
      ref={(element) => {
        node.current = element;
        cardRef(element);
      }}
      role="option"
      aria-selected={isSelected}
      tabIndex={isFocusable ? 0 : -1}
      className={classes}
      onClick={() => onSelect(session.sessionId)}
      onKeyDown={onKeyDown}
      data-session-id={session.sessionId}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={dominant ? "text-base font-semibold" : "text-sm font-medium"}>{label}</span>
        <span className="font-mono text-xs text-muted">…{shortId(session.sessionId)}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <StatusPill status={session.status} muted={isStale} />
          {!compact && <PriorityBadge priority={session.priority} />}
        </span>
      </div>

      {!compact && reason && (
        <p className={`mt-1 flex items-start gap-2 text-sm ${dominant ? "" : "text-muted"}`}>
          <span className={`${session.classificationSource === "ai" ? "italic" : ""} ${dominant ? "" : "truncate"}`}>{reason}</span>
          <SourceBadge source={session.classificationSource} confidence={session.classificationConfidence} />
        </p>
      )}

      <p className="mt-1 text-xs text-muted">
        {compact ? (
          <>
            Ended <RelativeTime iso={session.endedAt ?? session.lastSeenAt} nowMs={nowMs} ago />
          </>
        ) : (
          <>
            last activity: <span className="font-mono">{humaniseEventType(session.lastEventType)}</span> ·{" "}
            <RelativeTime iso={session.lastSeenAt} nowMs={nowMs} ago />
          </>
        )}
      </p>

      {isStale && (
        <p className="mt-1 flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
          <ClockIcon size={12} />
          Last seen {relativeTimeAgo(session.lastSeenAt, nowMs)}, may be out of date
        </p>
      )}
    </li>
  );
}
