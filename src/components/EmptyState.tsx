export function EmptyState({
  variant,
  receiverUrl,
  hiddenEnded = 0,
  onClearFilters,
}: {
  variant: "no-sessions" | "filtered-out";
  receiverUrl?: string;
  hiddenEnded?: number;
  onClearFilters?: () => void;
}) {
  if (variant === "no-sessions") {
    return (
      <div className="rounded-md border border-dashed border-edge px-6 py-10 text-center">
        <p className="text-base font-medium">No Claude Code sessions seen yet</p>
        <p className="mt-2 text-sm text-muted">
          Run <code className="rounded bg-zinc-100 px-1 font-mono text-xs dark:bg-zinc-800">pnpm hooks:install</code> in this
          repository, then start a Claude Code session.
        </p>
        {receiverUrl && (
          <p className="mt-1 text-xs text-muted">
            Receiver at <span className="font-mono">{receiverUrl}</span>
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="rounded-md border border-dashed border-edge px-6 py-8 text-center">
      <p className="text-sm font-medium">No sessions match these filters</p>
      {hiddenEnded > 0 && (
        <p className="mt-1 text-xs text-muted">
          {hiddenEnded} ended {hiddenEnded === 1 ? "session is" : "sessions are"} hidden
        </p>
      )}
      {onClearFilters && (
        <button
          type="button"
          onClick={onClearFilters}
          className="mt-3 rounded border border-edge px-3 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
