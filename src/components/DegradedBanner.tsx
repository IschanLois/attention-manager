"use client";

import { XIcon } from "./icons";

export type BannerKind = "disconnected" | "ai-unavailable" | "ai-not-installed" | "ai-error" | "db-error";

const RED = "border-red-500 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200";
const AMBER = "border-amber-500 bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200";

const STYLES: Record<BannerKind, string> = {
  disconnected: RED,
  "ai-unavailable": AMBER,
  "ai-not-installed": AMBER,
  "ai-error": AMBER,
  "db-error": RED,
};

export function DegradedBanner({
  kind,
  message,
  detail,
  retryIn,
  onRetry,
  onDismiss,
}: {
  kind: BannerKind;
  message: string;
  detail?: string | null;
  retryIn?: number | null;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  const alert = kind === "disconnected";
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm ${STYLES[kind]}`}>
      <span role={alert ? "alert" : undefined}>{message}</span>
      {detail && <span className="font-mono text-xs opacity-80">{detail}</span>}
      {retryIn !== null && retryIn !== undefined && <span className="text-xs opacity-80">Retrying in {retryIn}s…</span>}
      {onRetry && (
        <button type="button" onClick={onRetry} className="rounded border border-current px-2 py-0.5 text-xs">
          Retry now
        </button>
      )}
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="ml-auto rounded p-0.5 hover:opacity-70">
          <XIcon size={14} />
        </button>
      )}
    </div>
  );
}
