"use client";

import {
  PRIORITY_LABELS,
  PRIORITY_VALUES,
  STATUS_LABELS,
  STATUS_VALUES,
  type Filters,
  type Priority,
  type SessionStatus,
  type SortMode,
} from "@/lib/types";

export interface FilterToolbarProps {
  filters: Filters;
  statusCounts: Record<SessionStatus, number>;
  priorityCounts: Record<Priority, number>;
  onChange: (filters: Filters) => void;
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function Chip({ pressed, label, count, onClick }: { pressed: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
        pressed
          ? "border-blue-600 bg-blue-600 text-white dark:border-blue-400 dark:bg-blue-400 dark:text-zinc-950"
          : "border-edge bg-card text-muted hover:text-foreground"
      }`}
    >
      {label} <span className="opacity-80">{count}</span>
    </button>
  );
}

export function FilterToolbar({ filters, statusCounts, priorityCounts, onChange }: FilterToolbarProps) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-edge bg-card px-3 py-2 text-sm">
      <div role="group" aria-label="Filter by status" className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-medium text-muted">Status</span>
        {STATUS_VALUES.map((status) => (
          <Chip
            key={status}
            label={STATUS_LABELS[status]}
            count={statusCounts[status]}
            pressed={filters.statuses.includes(status)}
            onClick={() => onChange({ ...filters, statuses: toggle(filters.statuses, status) })}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label="Filter by priority" className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-medium text-muted">Priority</span>
          {PRIORITY_VALUES.map((priority) => (
            <Chip
              key={priority}
              label={titleCase(PRIORITY_LABELS[priority])}
              count={priorityCounts[priority]}
              pressed={filters.priorities.includes(priority)}
              onClick={() => onChange({ ...filters, priorities: toggle(filters.priorities, priority) })}
            />
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={filters.hideEnded}
            onChange={(e) => onChange({ ...filters, hideEnded: e.target.checked })}
          />
          Hide ended
        </label>
        <label className="ml-auto flex items-center gap-1.5 text-xs">
          Sort
          <select
            value={filters.sort}
            onChange={(e) => onChange({ ...filters, sort: e.target.value as SortMode })}
            className="rounded border border-edge bg-surface px-1.5 py-0.5 text-xs"
          >
            <option value="attention">Attention (default)</option>
            <option value="recent">Most recent</option>
            <option value="label">Label A–Z</option>
          </select>
        </label>
      </div>
    </div>
  );
}
