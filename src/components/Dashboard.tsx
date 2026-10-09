"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { applyFilters, isFiltering, DEFAULT_FILTERS, serializeFilters } from "@/lib/filters";
import { useClock } from "@/lib/hooks/useClock";
import { useSessionStream } from "@/lib/hooks/useSessionStream";
import { attentionCount, isStale, sortSessions } from "@/lib/sort";
import {
  PRIORITY_VALUES,
  STATUS_VALUES,
  type Filters,
  type HealthReport,
  type Priority,
  type SessionStatus,
  type SessionsSnapshot,
} from "@/lib/types";
import { DegradedBanner, type BannerKind } from "./DegradedBanner";
import { DiagnosticsStrip } from "./DiagnosticsStrip";
import { EmptyState } from "./EmptyState";
import { FilterToolbar } from "./FilterToolbar";
import { HeaderBar } from "./HeaderBar";
import { SessionDetail } from "./SessionDetail";
import { SessionList } from "./SessionList";

export interface DashboardProps {
  initialSnapshot: SessionsSnapshot | null;
  initialHealth: HealthReport | null;
  initialFilters: Filters;
  receiverUrl: string;
  serverNow: string;
}

function useRetryCountdown(retryAt: number | null, serverNow: string): number | null {
  const tick = useClock(1_000, serverNow, retryAt !== null);
  if (retryAt === null) return null;
  return Math.max(0, Math.ceil((retryAt - tick) / 1000));
}

function aiBanner(health: HealthReport | null): { kind: BannerKind; message: string; detail: string | null } | null {
  if (!health) return null;
  if (!health.model.reachable) {
    return { kind: "ai-unavailable", message: "Local AI unavailable: contextual classification off, rule-based only.", detail: health.model.url };
  }
  if (!health.model.modelInstalled) {
    return {
      kind: "ai-not-installed",
      message: `Model ${health.model.model} not installed in Ollama. Rule-based classification only; see the README setup section.`,
      detail: null,
    };
  }
  if (health.lastClassificationError) {
    return { kind: "ai-error", message: "Last classification failed; affected sessions show their rule-based state.", detail: health.lastClassificationError.message };
  }
  return null;
}

export function Dashboard({ initialSnapshot, initialHealth, initialFilters, receiverUrl, serverNow }: DashboardProps) {
  const stream = useSessionStream({ initialSnapshot, initialHealth });
  const nowMs = useClock(30_000, serverNow);
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dismissedAiBanner, setDismissedAiBanner] = useState<string | null>(null);
  const retryIn = useRetryCountdown(stream.retryAt, serverNow);

  const disconnected = stream.connection !== "live";

  useEffect(() => {
    const query = serializeFilters(filters);
    const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
    if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", url);
  }, [filters]);

  const sorted = useMemo(
    () => sortSessions(stream.sessions, { nowMs, staleAfterMs: stream.staleAfterMs, mode: filters.sort }),
    [stream.sessions, nowMs, stream.staleAfterMs, filters.sort],
  );
  const visible = useMemo(() => applyFilters(sorted, filters), [sorted, filters]);
  const active = useMemo(() => visible.filter((s) => s.status !== "ended"), [visible]);
  const ended = useMemo(() => visible.filter((s) => s.status === "ended"), [visible]);
  const hiddenEnded = filters.hideEnded ? stream.sessions.filter((s) => s.status === "ended").length : 0;

  const counts = useMemo(() => {
    const statusCounts = Object.fromEntries(STATUS_VALUES.map((s) => [s, 0])) as Record<SessionStatus, number>;
    const priorityCounts = Object.fromEntries(PRIORITY_VALUES.map((p) => [p, 0])) as Record<Priority, number>;
    for (const session of stream.sessions) {
      statusCounts[session.status] += 1;
      priorityCounts[session.priority] += 1;
    }
    return { statusCounts, priorityCounts };
  }, [stream.sessions]);

  const needing = attentionCount(stream.sessions);
  useEffect(() => {
    document.title = needing > 0 ? `(${needing}) Attention Manager` : "Attention Manager";
  }, [needing]);

  const selected = selectedId ? (stream.sessions.find((s) => s.sessionId === selectedId) ?? null) : null;
  const closeDetail = useCallback(() => setSelectedId(null), []);

  const lastEventAt = useMemo(() => {
    let latest = stream.health?.lastEventAt ?? null;
    for (const session of stream.sessions) {
      if (latest === null || Date.parse(session.lastSeenAt) > Date.parse(latest)) latest = session.lastSeenAt;
    }
    return latest;
  }, [stream.health, stream.sessions]);

  const ai = aiBanner(stream.health);
  const showAiBanner = ai !== null && dismissedAiBanner !== ai.kind;

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col px-4 pb-4">
      <HeaderBar connection={stream.connection} attentionCount={needing} onReconnect={stream.reconnect} />

      <div className="flex flex-col gap-2">
        {disconnected && (
          <DegradedBanner
            kind="disconnected"
            message="Lost connection to the receiver. Showing last known state."
            retryIn={retryIn}
            onRetry={stream.reconnect}
          />
        )}
        {stream.health && !stream.health.sqlite.ok && (
          <DegradedBanner kind="db-error" message="SQLite unavailable; state will not survive restart." detail={stream.health.sqlite.error} />
        )}
        {showAiBanner && ai && (
          <DegradedBanner kind={ai.kind} message={ai.message} detail={ai.detail} onDismiss={() => setDismissedAiBanner(ai.kind)} />
        )}
      </div>

      <div className="mt-3">
        <FilterToolbar filters={filters} statusCounts={counts.statusCounts} priorityCounts={counts.priorityCounts} onChange={setFilters} />
      </div>

      <div className={`mt-3 grid gap-4 ${selected ? "min-[900px]:grid-cols-[minmax(0,1fr)_380px]" : ""}`}>
        <div className="min-w-0">
          {stream.sessions.length === 0 ? (
            <EmptyState variant="no-sessions" receiverUrl={receiverUrl} />
          ) : visible.length === 0 ? (
            <EmptyState
              variant="filtered-out"
              hiddenEnded={hiddenEnded}
              onClearFilters={isFiltering(filters) ? () => setFilters({ ...DEFAULT_FILTERS, sort: filters.sort }) : undefined}
            />
          ) : (
            <SessionList
              active={active}
              ended={ended}
              selectedId={selectedId}
              nowMs={nowMs}
              staleAfterMs={stream.staleAfterMs}
              forceStale={disconnected}
              updatedAt={stream.updatedAt}
              onSelect={setSelectedId}
              onEscape={closeDetail}
            />
          )}
        </div>
        {selected && (
          <SessionDetail
            key={selected.sessionId}
            session={selected}
            isStale={disconnected || isStale(selected, nowMs, stream.staleAfterMs)}
            nowMs={nowMs}
            onClose={closeDetail}
          />
        )}
      </div>

      <div aria-live="polite" className="sr-only">
        {stream.announcement?.text ?? ""}
      </div>

      <DiagnosticsStrip health={stream.health} connection={stream.connection} nowMs={nowMs} staleAfterMs={stream.staleAfterMs} lastEventAt={lastEventAt} />
    </div>
  );
}
