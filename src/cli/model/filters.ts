import { PRIORITY_VALUES, SORT_MODES, STATUS_VALUES, type Filters, type Priority, type SessionView } from "./types.ts";

export const DEFAULT_FILTERS: Filters = { statuses: [], priorities: [], risks: [], hideEnded: true, sort: "attention", label: "" };

export function prioritiesAtLeast(minimum: Priority): Priority[] {
  return PRIORITY_VALUES.slice(0, PRIORITY_VALUES.indexOf(minimum) + 1);
}

export interface FilterFlags {
  status?: string;
  minPriority?: string;
  minRisk?: string;
  all?: boolean;
  sort?: string;
}

class FilterFlagError extends Error {}

function parseList<T extends string>(raw: string | undefined, allowed: readonly T[], flag: string): T[] {
  if (!raw) return [];
  const values = [...new Set(raw.split(",").map((v) => v.trim()).filter(Boolean))];
  const unknown = values.filter((v) => !(allowed as readonly string[]).includes(v));
  if (unknown.length) throw new FilterFlagError(`unknown ${flag} value "${unknown.join(",")}"; expected one of ${allowed.join(", ")}`);
  return values as T[];
}

function parseOne<T extends string>(raw: string | undefined, allowed: readonly T[], flag: string): T | null {
  return raw ? parseList(raw, allowed, flag)[0] ?? null : null;
}

export function parseFilterFlags(flags: FilterFlags): { ok: true; filters: Filters } | { ok: false; error: string } {
  try {
    const statuses = parseList(flags.status, STATUS_VALUES, "--status");
    const minPriority = parseOne(flags.minPriority, PRIORITY_VALUES, "--min-priority");
    const minRisk = parseOne(flags.minRisk, PRIORITY_VALUES, "--min-risk");
    return {
      ok: true,
      filters: {
        ...DEFAULT_FILTERS,
        statuses,
        priorities: minPriority ? prioritiesAtLeast(minPriority) : [],
        risks: minRisk ? prioritiesAtLeast(minRisk) : [],
        hideEnded: !flags.all && !statuses.includes("ended"),
        sort: parseOne(flags.sort, SORT_MODES, "--sort") ?? "attention",
      },
    };
  } catch (error) {
    if (error instanceof FilterFlagError) return { ok: false, error: error.message };
    throw error;
  }
}

export function isFiltering(filters: Filters): boolean {
  return filters.statuses.length > 0 || filters.priorities.length > 0 || filters.risks.length > 0 || !filters.hideEnded || filters.label !== "";
}

export function applyFilters(sessions: readonly SessionView[], filters: Filters): SessionView[] {
  const label = filters.label.trim().toLowerCase();
  return sessions.filter((session) => {
    if (filters.hideEnded && session.status === "ended") return false;
    if (filters.statuses.length && !filters.statuses.includes(session.status)) return false;
    if (filters.priorities.length && !filters.priorities.includes(session.priority)) return false;
    if (filters.risks.length && !filters.risks.includes(session.taskSeverity)) return false;
    if (label && !(session.label ?? "").toLowerCase().includes(label) && !session.sessionId.toLowerCase().includes(label)) return false;
    return true;
  });
}
