"use client";

import type { ConnectionState } from "@/lib/types";
import { RefreshIcon } from "./icons";

const CONNECTION_TEXT: Record<ConnectionState, string> = {
  live: "Live",
  reconnecting: "Reconnecting",
  offline: "Offline",
};

export function HeaderBar({
  connection,
  attentionCount,
  highRiskCount,
  onReconnect,
}: {
  connection: ConnectionState;
  attentionCount: number;
  highRiskCount: number;
  onReconnect: () => void;
}) {
  const dot =
    connection === "live"
      ? "bg-green-500"
      : connection === "reconnecting"
        ? "border-2 border-amber-500 bg-transparent am-dot-pulse"
        : "border-2 border-red-500 bg-transparent";
  return (
    <header className="flex flex-wrap items-center gap-3 py-3">
      <h1 className="text-lg font-semibold">Attention Manager</h1>
      <p className="flex items-center gap-2 text-sm text-muted">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`} aria-hidden="true" />
        <span>{CONNECTION_TEXT[connection]}</span>
        <span aria-hidden="true">·</span>
        <span className={attentionCount > 0 ? "font-medium text-foreground" : ""}>
          {attentionCount} need{attentionCount === 1 ? "s" : ""} attention
        </span>
        <span aria-hidden="true">·</span>
        <span className={highRiskCount > 0 ? "font-medium text-red-700 dark:text-red-300" : ""}>{highRiskCount} high-risk</span>
      </p>
      <button
        type="button"
        onClick={onReconnect}
        className="ml-auto inline-flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <RefreshIcon size={14} />
        {connection === "live" ? "Refresh" : "Reconnect"}
      </button>
    </header>
  );
}
