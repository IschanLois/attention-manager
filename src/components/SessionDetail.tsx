"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { absoluteTime, humaniseEventType, sessionLabel } from "@/lib/format";
import type { SessionDetail as SessionDetailPayload, SessionView, StoredEvent } from "@/lib/types";
import { PriorityBadge, RelativeTime, SourceBadge, StatusPill } from "./badges";
import { CopyIcon, XIcon } from "./icons";

type LoadState = { kind: "loading" } | { kind: "ready"; events: StoredEvent[] } | { kind: "error"; message: string };

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-edge py-2 text-sm last:border-b-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{term}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      /* clipboard unavailable; the id is still visible for manual selection */
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
      aria-label="Copy session id"
    >
      <CopyIcon size={12} />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function SessionDetail({
  session,
  isStale,
  nowMs,
  onClose,
}: {
  session: SessionView;
  isStale: boolean;
  nowMs: number;
  onClose: () => void;
}) {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const label = sessionLabel(session.label, session.sessionId);
  const titleId = `session-detail-title-${session.sessionId.slice(-4)}`;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      opener?.focus?.();
    };
  }, [session.sessionId]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/sessions/${encodeURIComponent(session.sessionId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? "Session no longer known to the receiver" : "Receiver unreachable");
        const payload = (await res.json()) as SessionDetailPayload;
        setLoad({ kind: "ready", events: payload.events });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({ kind: "error", message: err instanceof Error ? err.message : "Failed to load" });
      });
    return () => controller.abort();
  }, [session.sessionId, session.lastSeenAt, session.classifiedAt]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const pressed = e.key;
    if (pressed === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (pressed !== "Tab" || !panelRef.current) return;
    const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (nodes.length === 0) return;
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const reason =
    session.classificationSource === "fallback" && !session.attentionReason
      ? "Contextual classification unavailable; showing rule-based state."
      : (session.attentionReason ?? "No attention reason recorded.");

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      className="am-drawer-enter fixed inset-0 z-40 flex flex-col overflow-y-auto bg-surface p-4 min-[900px]:static min-[900px]:inset-auto min-[900px]:z-auto min-[900px]:max-h-[calc(100vh-2rem)] min-[900px]:rounded-md min-[900px]:border min-[900px]:border-edge min-[900px]:bg-card"
    >
      <div className="flex items-start gap-2">
        <h2 id={titleId} className="text-base font-semibold">
          {label}
        </h2>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close session details"
          className="ml-auto rounded border border-edge p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <XIcon size={14} />
        </button>
      </div>

      <dl className="mt-2">
        <Row term="Session id">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{session.sessionId}</span>
            <CopyButton value={session.sessionId} />
          </span>
        </Row>
        <Row term="State">
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusPill status={session.status} muted={isStale} />
            <PriorityBadge priority={session.priority} />
          </span>
        </Row>
        <Row term="Reason">
          <span className="flex flex-wrap items-start gap-2">
            <span className={session.classificationSource === "ai" ? "italic" : ""}>{reason}</span>
            <SourceBadge source={session.classificationSource} confidence={session.classificationConfidence} />
          </span>
          {session.classifiedAt && (
            <span className="mt-1 block text-xs text-muted">
              Classified <RelativeTime iso={session.classifiedAt} nowMs={nowMs} ago />
              {session.classificationConfidence !== null && ` · confidence ${Math.round(session.classificationConfidence * 100)}% (uncalibrated)`}
            </span>
          )}
        </Row>
        {session.classificationEvidence.length > 0 && (
          <Row term="Evidence">
            <ul className="list-disc pl-5 text-sm">
              {session.classificationEvidence.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </Row>
        )}
        {session.classificationError && (
          <Row term="Inference error">
            <span className="text-amber-700 dark:text-amber-300">{session.classificationError}</span>
          </Row>
        )}
        <Row term="Last seen">
          <RelativeTime iso={session.lastSeenAt} nowMs={nowMs} ago />
          <span className="ml-2 text-xs text-muted">{absoluteTime(session.lastSeenAt)}</span>
          {isStale && <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">may be out of date</span>}
        </Row>
        {session.startedAt && (
          <Row term="Started">
            <RelativeTime iso={session.startedAt} nowMs={nowMs} ago />
          </Row>
        )}
        {session.endedAt && (
          <Row term="Ended">
            <RelativeTime iso={session.endedAt} nowMs={nowMs} ago />
          </Row>
        )}
        {session.pendingPermissionToolUseId && (
          <Row term="Pending permission">
            <span className="font-mono text-xs">{session.pendingPermissionToolUseId}</span>
          </Row>
        )}
        <Row term="Find this session">
          <span className="text-xs text-muted">
            Look for the terminal whose working directory ends in{" "}
            <span className="font-mono">{session.label ?? "(unknown)"}</span>; the id above matches Claude Code&apos;s session id.
          </span>
        </Row>
      </dl>

      <h3 className="mt-4 text-xs font-medium uppercase tracking-wide text-muted">Recent events</h3>
      {load.kind === "loading" && <p className="mt-1 text-sm text-muted">Loading…</p>}
      {load.kind === "error" && <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">{load.message}</p>}
      {load.kind === "ready" && load.events.length === 0 && <p className="mt-1 text-sm text-muted">No events retained.</p>}
      {load.kind === "ready" && load.events.length > 0 && (
        <ol className="mt-1 flex flex-col divide-y divide-edge text-sm">
          {load.events.map((event) => (
            <li key={event.id} className="flex flex-col gap-0.5 py-1.5">
              <span className="flex items-center gap-2">
                <span className="font-mono text-xs">{humaniseEventType(event.eventType)}</span>
                <span className="text-xs text-muted">
                  <RelativeTime iso={event.receivedAt} nowMs={nowMs} ago />
                </span>
              </span>
              {event.summary && <span className="text-xs text-muted">{event.summary}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
