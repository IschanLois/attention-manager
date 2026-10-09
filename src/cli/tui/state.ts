import { announcementFor } from "../model/announce.ts";
import { applyFilters, DEFAULT_FILTERS, prioritiesAtLeast } from "../model/filters.ts";
import { sortSessions } from "../model/sort.ts";
import { PRIORITY_VALUES, SORT_MODES, type ConnectionState, type Filters, type HealthReport, type SessionsSnapshot, type SessionView, type StoredEvent } from "../model/types.ts";

export type Tone = "info" | "success" | "warn" | "error";

export interface TuiState {
  now: number;
  sessions: SessionView[];
  staleAfterMs: number;
  health: HealthReport | null;
  connection: ConnectionState | "connecting";
  retryAt: number | null;
  selectedId: string | null;
  selectedIndex: number;
  view: "list" | "detail";
  filters: Filters;
  labelDraft: string | null;
  labelBeforeEdit: string;
  help: boolean;
  bell: boolean;
  bellCount: number;
  status: { text: string; tone: Tone; until: number } | null;
  highlights: Record<string, number>;
  flashUntil: number;
  detail: { sessionId: string; events: StoredEvent[] } | null;
}

export type Action =
  | { type: "snapshot"; snapshot: SessionsSnapshot }
  | { type: "session"; session: SessionView; at: number }
  | { type: "removed"; sessionId: string }
  | { type: "health"; health: HealthReport }
  | { type: "connection"; connection: TuiState["connection"]; retryAt: number | null }
  | { type: "move"; delta: number }
  | { type: "toggle-detail" }
  | { type: "back" }
  | { type: "cycle-sort" }
  | { type: "toggle-ended" }
  | { type: "priority"; level: 1 | 2 | 3 | 4 | 5 }
  | { type: "label-start" }
  | { type: "label-input"; text: string }
  | { type: "label-backspace" }
  | { type: "label-commit" }
  | { type: "label-cancel" }
  | { type: "toggle-help" }
  | { type: "toggle-bell" }
  | { type: "status"; text: string; tone: Tone; at: number; ttlMs?: number }
  | { type: "detail-loaded"; sessionId: string; events: StoredEvent[] }
  | { type: "tick"; now: number };

const HIGHLIGHT_MS = 15_000;
const FLASH_MS = 1_500;
const STATUS_MS = 8_000;
const LABEL_MAX = 64;

export function initialState({ bell }: { bell: boolean }): TuiState {
  return {
    now: Date.now(),
    sessions: [],
    staleAfterMs: 600_000,
    health: null,
    connection: "connecting",
    retryAt: null,
    selectedId: null,
    selectedIndex: 0,
    view: "list",
    filters: DEFAULT_FILTERS,
    labelDraft: null,
    labelBeforeEdit: "",
    help: false,
    bell,
    bellCount: 0,
    status: null,
    highlights: {},
    flashUntil: 0,
    detail: null,
  };
}

function activeFilters(state: TuiState): Filters {
  return state.labelDraft === null ? state.filters : { ...state.filters, label: state.labelDraft };
}

export function visibleSessions(state: TuiState, nowMs: number): SessionView[] {
  const filters = activeFilters(state);
  return sortSessions(applyFilters(state.sessions, filters), { nowMs, staleAfterMs: state.staleAfterMs, mode: filters.sort });
}

export function selectedSession(state: TuiState, nowMs: number): SessionView | null {
  const visible = visibleSessions(state, nowMs);
  if (visible.length === 0) return null;
  return visible.find((s) => s.sessionId === state.selectedId) ?? visible[Math.min(state.selectedIndex, visible.length - 1)]!;
}

// Re-anchor the selection after the list changed: keep the same session if still
// visible, otherwise fall back to whatever now sits at the previous position.
function reselect(state: TuiState, nowMs: number): TuiState {
  const visible = visibleSessions(state, nowMs);
  if (visible.length === 0) return { ...state, selectedId: null, selectedIndex: 0 };
  const index = visible.findIndex((s) => s.sessionId === state.selectedId);
  const nextIndex = index >= 0 ? index : Math.min(state.selectedIndex, visible.length - 1);
  return { ...state, selectedIndex: nextIndex, selectedId: visible[nextIndex]!.sessionId };
}

function withLabel(state: TuiState, labelDraft: string | null): TuiState {
  return reselect({ ...state, labelDraft }, state.now);
}

export function reduce(state: TuiState, action: Action): TuiState {
  switch (action.type) {
    case "snapshot": {
      const now = Date.parse(action.snapshot.now) || state.now;
      return reselect({ ...state, now, sessions: action.snapshot.sessions, staleAfterMs: action.snapshot.staleAfterMs, connection: "live", retryAt: null }, now);
    }
    case "session": {
      const previous = state.sessions.find((s) => s.sessionId === action.session.sessionId);
      const sessions = previous ? state.sessions.map((s) => (s.sessionId === action.session.sessionId ? action.session : s)) : [...state.sessions, action.session];
      let next: TuiState = { ...state, sessions, now: Math.max(state.now, action.at) };
      const text = announcementFor(previous, action.session);
      if (text) {
        next = {
          ...next,
          highlights: { ...next.highlights, [action.session.sessionId]: action.at + HIGHLIGHT_MS },
          flashUntil: action.at + FLASH_MS,
          bellCount: next.bell ? next.bellCount + 1 : next.bellCount,
          status: { text, tone: "warn", until: action.at + STATUS_MS },
        };
      }
      return reselect(next, action.at);
    }
    case "removed": {
      const { [action.sessionId]: _gone, ...highlights } = state.highlights;
      return reselect({ ...state, sessions: state.sessions.filter((s) => s.sessionId !== action.sessionId), highlights }, state.now);
    }
    case "health":
      return { ...state, health: action.health };
    case "connection":
      return { ...state, connection: action.connection, retryAt: action.retryAt };
    case "move": {
      const visible = visibleSessions(state, state.now);
      if (visible.length === 0) return state;
      const current = Math.max(0, visible.findIndex((s) => s.sessionId === state.selectedId));
      const index = Math.min(visible.length - 1, Math.max(0, current + action.delta));
      return { ...state, selectedIndex: index, selectedId: visible[index]!.sessionId };
    }
    case "toggle-detail":
      return { ...state, view: state.view === "detail" ? "list" : "detail" };
    case "back":
      if (state.help) return { ...state, help: false };
      return { ...state, view: "list" };
    case "cycle-sort": {
      const sort = SORT_MODES[(SORT_MODES.indexOf(state.filters.sort) + 1) % SORT_MODES.length]!;
      return reselect({ ...state, filters: { ...state.filters, sort } }, state.now);
    }
    case "toggle-ended":
      return reselect({ ...state, filters: { ...state.filters, hideEnded: !state.filters.hideEnded } }, state.now);
    case "priority": {
      const minimum = action.level === 5 ? null : PRIORITY_VALUES[action.level - 1]!;
      const wanted = minimum ? prioritiesAtLeast(minimum) : [];
      const same = wanted.length === state.filters.priorities.length && wanted.every((p, i) => state.filters.priorities[i] === p);
      return reselect({ ...state, filters: { ...state.filters, priorities: same ? [] : wanted } }, state.now);
    }
    case "label-start":
      return { ...state, labelDraft: state.filters.label, labelBeforeEdit: state.filters.label };
    case "label-input":
      return withLabel(state, ((state.labelDraft ?? "") + action.text.replace(/[\u0000-\u001f\u007f]/g, "")).slice(0, LABEL_MAX));
    case "label-backspace":
      return withLabel(state, (state.labelDraft ?? "").slice(0, -1));
    case "label-commit":
      return reselect({ ...state, filters: { ...state.filters, label: state.labelDraft ?? state.filters.label }, labelDraft: null }, state.now);
    case "label-cancel":
      return reselect({ ...state, filters: { ...state.filters, label: state.labelBeforeEdit }, labelDraft: null }, state.now);
    case "toggle-help":
      return { ...state, help: !state.help };
    case "toggle-bell":
      return { ...state, bell: !state.bell };
    case "status":
      return { ...state, status: { text: action.text, tone: action.tone, until: action.at + (action.ttlMs ?? STATUS_MS) } };
    case "detail-loaded":
      return { ...state, detail: { sessionId: action.sessionId, events: action.events } };
    case "tick": {
      const highlights = Object.fromEntries(Object.entries(state.highlights).filter(([, until]) => until > action.now));
      const status = state.status && state.status.until > action.now ? state.status : null;
      return { ...state, now: action.now, highlights, status };
    }
  }
}
