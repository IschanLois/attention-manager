import { describe, expect, it } from "vitest";
import { initialState, reduce, selectedSession, visibleSessions, type TuiState } from "@/cli/tui/state";
import { FIXTURE_NOW, minutesAgo, sessionView } from "./fixtures/sessions";

const snapshot = (sessions = SESSIONS) => ({ type: "snapshot" as const, snapshot: { sessions, now: new Date(FIXTURE_NOW).toISOString(), staleAfterMs: 600_000 } });

const SESSIONS = [
  sessionView({ sessionId: "sess-a-00000001", label: "alpha", priority: "high", status: "needs_attention", taskSeverity: "high", lastSeenAt: minutesAgo(2) }),
  sessionView({ sessionId: "sess-b-00000001", label: "beta", lastSeenAt: minutesAgo(1) }),
  sessionView({ sessionId: "sess-c-00000001", label: "gamma", status: "ended", endedAt: minutesAgo(5), lastSeenAt: minutesAgo(5) }),
];

function loaded(overrides: Partial<TuiState> = {}): TuiState {
  return { ...reduce(initialState({ bell: true }), snapshot()), ...overrides };
}

const ids = (state: TuiState) => visibleSessions(state, FIXTURE_NOW).map((s) => s.label);

describe("tui state", () => {
  it("starts connecting, goes live on a snapshot and selects the top session", () => {
    expect(initialState({ bell: true }).connection).toBe("connecting");
    const state = loaded();
    expect(state.connection).toBe("live");
    expect(ids(state)).toEqual(["alpha", "beta"]);
    expect(selectedSession(state, FIXTURE_NOW)?.label).toBe("alpha");
  });

  it("moves the selection within bounds", () => {
    let state = loaded();
    state = reduce(state, { type: "move", delta: 1 });
    expect(selectedSession(state, FIXTURE_NOW)?.label).toBe("beta");
    state = reduce(state, { type: "move", delta: 1 });
    expect(selectedSession(state, FIXTURE_NOW)?.label).toBe("beta");
    state = reduce(state, { type: "move", delta: -5 });
    expect(selectedSession(state, FIXTURE_NOW)?.label).toBe("alpha");
  });

  it("keeps the selection on the same session when the order changes, and clamps when it disappears", () => {
    let state = reduce(loaded(), { type: "move", delta: 1 });
    const urgentBeta = sessionView({ sessionId: "sess-b-00000001", label: "beta", priority: "critical", status: "error", taskSeverity: "critical" });
    state = reduce(state, { type: "session", session: urgentBeta, at: FIXTURE_NOW });
    expect(ids(state)).toEqual(["beta", "alpha"]);
    expect(selectedSession(state, FIXTURE_NOW)?.label).toBe("beta");
    state = reduce(state, { type: "removed", sessionId: "sess-b-00000001" });
    expect(selectedSession(state, FIXTURE_NOW)?.label).toBe("alpha");
  });

  it("raises a highlight, a header flash, a bell and a status line when a session newly needs input", () => {
    const state = reduce(loaded(), { type: "session", session: sessionView({ sessionId: "sess-b-00000001", label: "beta", status: "needs_attention", attentionReason: "Waiting for input" }), at: FIXTURE_NOW });
    expect(state.highlights["sess-b-00000001"]).toBeGreaterThan(FIXTURE_NOW);
    expect(state.flashUntil).toBeGreaterThan(FIXTURE_NOW);
    expect(state.bellCount).toBe(1);
    expect(state.status).toMatchObject({ text: "Session beta now needs input: Waiting for input", tone: "warn" });
  });

  it("cues on critical risk, does not ring when the bell is off, and does not repeat for the same state", () => {
    let state = loaded({ bell: false });
    const risky = sessionView({ sessionId: "sess-b-00000001", label: "beta", taskSeverity: "critical" });
    state = reduce(state, { type: "session", session: risky, at: FIXTURE_NOW });
    expect(state.bellCount).toBe(0);
    expect(state.highlights["sess-b-00000001"]).toBeDefined();
    const again = reduce(state, { type: "session", session: risky, at: FIXTURE_NOW + 1000 });
    expect(again.flashUntil).toBe(state.flashUntil);
  });

  it("does not cue for transitions replayed by a reconnect snapshot", () => {
    const state = reduce(loaded(), snapshot([sessionView({ sessionId: "sess-b-00000001", label: "beta", status: "error" })]));
    expect(state.bellCount).toBe(0);
    expect(state.highlights).toEqual({});
  });

  it("expires highlights and status lines on tick", () => {
    let state = reduce(loaded(), { type: "session", session: sessionView({ sessionId: "sess-b-00000001", label: "beta", status: "error" }), at: FIXTURE_NOW });
    state = reduce(state, { type: "tick", now: FIXTURE_NOW + 60_000 });
    expect(state.highlights).toEqual({});
    expect(state.status).toBeNull();
  });

  it("cycles sort modes, toggles ended sessions and applies risk shortcuts", () => {
    let state = loaded();
    state = reduce(state, { type: "cycle-sort" });
    expect(state.filters.sort).toBe("recent");
    expect(ids(state)).toEqual(["beta", "alpha"]);
    state = reduce(state, { type: "toggle-ended" });
    expect(ids(state)).toContain("gamma");
    state = reduce(state, { type: "priority", level: 2 });
    expect(state.filters.risks).toEqual(["critical", "high"]);
    expect(state.filters.priorities).toEqual([]);
    expect(ids(state)).toEqual(["alpha"]);
    state = reduce(state, { type: "priority", level: 2 });
    expect(state.filters.risks).toEqual([]);
    state = reduce(state, { type: "priority", level: 3 });
    state = reduce(state, { type: "priority", level: 5 });
    expect(state.filters.risks).toEqual([]);
  });

  it("edits a label query and applies it live, restoring it on cancel", () => {
    let state = reduce(loaded(), { type: "label-start" });
    for (const ch of "bet") state = reduce(state, { type: "label-input", text: ch });
    expect(state.labelDraft).toBe("bet");
    expect(ids(state)).toEqual(["beta"]);
    state = reduce(state, { type: "label-backspace" });
    state = reduce(state, { type: "label-commit" });
    expect(state.labelDraft).toBeNull();
    expect(state.filters.label).toBe("be");
    state = reduce(state, { type: "label-start" });
    state = reduce(state, { type: "label-input", text: "zzz" });
    state = reduce(state, { type: "label-cancel" });
    expect(state.filters.label).toBe("be");
  });

  it("tracks connection loss, health and the detail pane", () => {
    let state = reduce(loaded(), { type: "connection", connection: "reconnecting", retryAt: FIXTURE_NOW + 2000 });
    expect(state).toMatchObject({ connection: "reconnecting", retryAt: FIXTURE_NOW + 2000 });
    state = reduce(state, { type: "toggle-detail" });
    expect(state.view).toBe("detail");
    state = reduce(state, { type: "back" });
    expect(state.view).toBe("list");
    state = reduce(state, { type: "detail-loaded", sessionId: "sess-a-00000001", events: [] });
    expect(state.detail).toEqual({ sessionId: "sess-a-00000001", events: [] });
    state = reduce(state, { type: "toggle-help" });
    expect(state.help).toBe(true);
    state = reduce(state, { type: "back" });
    expect(state.help).toBe(false);
  });
});
