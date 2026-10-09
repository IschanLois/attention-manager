"use client";

import { relativeTime, relativeTimeAgo } from "@/lib/format";
import type { ConnectionState, HealthReport } from "@/lib/types";

function Dot({ ok, warn = false }: { ok: boolean; warn?: boolean }) {
  const color = ok ? "bg-green-500" : warn ? "border-2 border-amber-500" : "border-2 border-red-500";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} aria-hidden="true" />;
}

function modelSummary(model: HealthReport["model"] | undefined): string {
  if (!model) return "unknown";
  if (!model.reachable) return "unreachable";
  if (!model.modelInstalled) return `${model.model} not installed`;
  return model.model;
}

export function DiagnosticsStrip({
  health,
  connection,
  nowMs,
  staleAfterMs,
  lastEventAt,
}: {
  health: HealthReport | null;
  connection: ConnectionState;
  nowMs: number;
  staleAfterMs: number;
  lastEventAt: string | null;
}) {
  const receiverOk = connection === "live";
  const model = health?.model;
  const modelOk = Boolean(model?.reachable && model?.modelInstalled);
  const quiet = lastEventAt !== null && receiverOk && nowMs - Date.parse(lastEventAt) > staleAfterMs;

  return (
    <footer className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-edge pt-3 text-xs text-muted">
      <span className="flex items-center gap-1.5">
        <Dot ok={receiverOk} warn={connection === "reconnecting"} />
        Receiver {receiverOk ? "connected" : connection}
        {health && (
          <span className="font-mono">
            {health.receiver.host}:{health.receiver.port}
          </span>
        )}
      </span>
      <span className="flex items-center gap-1.5">
        <Dot ok={modelOk} warn />
        Model <span className="font-mono">{modelSummary(model)}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <Dot ok={health?.sqlite.ok ?? false} />
        SQLite {health ? (health.sqlite.ok ? "ok" : "unavailable") : "unknown"}
      </span>
      {lastEventAt === null ? (
        <span>no events yet</span>
      ) : quiet ? (
        <span className="text-amber-700 dark:text-amber-300">no events for {relativeTime(lastEventAt, nowMs)}</span>
      ) : (
        <span>last event {relativeTimeAgo(lastEventAt, nowMs)}</span>
      )}
      {health?.lastClassificationError && (
        <span className="text-amber-700 dark:text-amber-300">
          last classification error {relativeTimeAgo(health.lastClassificationError.at, nowMs)}
        </span>
      )}
      {health && <span className="ml-auto font-mono">v{health.version}</span>}
    </footer>
  );
}
