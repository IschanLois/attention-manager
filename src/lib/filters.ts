import { PRIORITY_VALUES, SORT_MODES, STATUS_VALUES, type Filters, type Priority, type SessionStatus, type SessionView, type SortMode } from "./types";

export const DEFAULT_FILTERS: Filters = { statuses: [], priorities: [], hideEnded: true, sort: "attention" };

type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function pickKnown<T extends string>(raw: string, allowed: readonly T[]): T[] {
  const seen = new Set<T>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if ((allowed as readonly string[]).includes(trimmed)) seen.add(trimmed as T);
  }
  return [...seen];
}

export function parseFilters(params: RawParams | URLSearchParams): Filters {
  const get = (key: string): string =>
    params instanceof URLSearchParams ? (params.get(key) ?? "") : first(params[key]);
  const sortRaw = get("sort");
  return {
    statuses: pickKnown<SessionStatus>(get("status"), STATUS_VALUES),
    priorities: pickKnown<Priority>(get("priority"), PRIORITY_VALUES),
    hideEnded: get("ended") !== "show",
    sort: (SORT_MODES as readonly string[]).includes(sortRaw) ? (sortRaw as SortMode) : "attention",
  };
}

export function serializeFilters(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.statuses.length) params.set("status", filters.statuses.join(","));
  if (filters.priorities.length) params.set("priority", filters.priorities.join(","));
  if (!filters.hideEnded) params.set("ended", "show");
  if (filters.sort !== "attention") params.set("sort", filters.sort);
  return params.toString();
}

export function isFiltering(filters: Filters): boolean {
  return filters.statuses.length > 0 || filters.priorities.length > 0 || !filters.hideEnded;
}

export function applyFilters(sessions: readonly SessionView[], filters: Filters): SessionView[] {
  return sessions.filter((session) => {
    if (filters.hideEnded && session.status === "ended") return false;
    if (filters.statuses.length && !filters.statuses.includes(session.status)) return false;
    if (filters.priorities.length && !filters.priorities.includes(session.priority)) return false;
    return true;
  });
}
