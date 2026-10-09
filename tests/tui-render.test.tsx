import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { Screen } from "@/cli/tui/Screen";
import { initialState, reduce, type TuiState } from "@/cli/tui/state";
import { createTheme, supportsUnicode } from "@/cli/tui/theme";
import { FIXTURE_NOW, minutesAgo, sessionView } from "./fixtures/sessions";

const plain = createTheme({ color: false, unicode: false });
const HEALTH = {
  ok: true,
  app: "attention-manager",
  version: "0.1.0",
  uptimeSeconds: 1,
  receiver: { host: "127.0.0.1", port: 4318, sseClients: 1 },
  sqlite: { ok: true, path: "/s", error: null },
  model: { reachable: true, modelInstalled: true, model: "qwen3:1.7b", url: "http://127.0.0.1:11434", error: null },
  lastEventAt: null,
  lastClassificationError: null,
  sessionCount: 2,
};

function withSessions(): TuiState {
  const sessions = [
    sessionView({
      sessionId: "sess-a-00000001",
      label: "billing-api",
      status: "needs_attention",
      priority: "high",
      attentionReason: "Waiting for a permission decision",
      taskSummary: "Migrate the invoices table",
      taskSeverity: "critical",
      taskSeverityReason: "Dropping a production table",
      recentActions: ["Bash: psql -c 'drop table invoices'"],
      terminal: { tmux: { socket: "/tmp/t", pane: "%2" } },
    }),
    sessionView({ sessionId: "sess-b-00000001", label: "docs-site", lastSeenAt: minutesAgo(3) }),
  ];
  let state = reduce(initialState({ bell: true }), { type: "snapshot", snapshot: { sessions, now: new Date(FIXTURE_NOW).toISOString(), staleAfterMs: 600_000 } });
  state = reduce(state, { type: "health", health: HEALTH });
  return state;
}

function frame(state: TuiState, width: number, options: { classifierEnabled?: boolean; height?: number } = {}): string {
  const { lastFrame, unmount } = render(<Screen state={state} now={FIXTURE_NOW} width={width} height={options.height ?? 30} theme={plain} classifierEnabled={options.classifierEnabled ?? true} />);
  const text = lastFrame() ?? "";
  unmount();
  return text;
}

function rowOf(text: string, label: string): string {
  return text.split("\n").find((line) => line.includes(label)) ?? "";
}

describe("Screen", () => {
  it("shows the header counts and the full-width list above the detail", () => {
    const text = frame(withSessions(), 120);
    expect(text).toMatch(/live/);
    expect(text).toMatch(/2 sessions\W+1 need you\W+1 high risk/);
    expect(text.indexOf("billing-api")).toBeLessThan(text.indexOf("docs-site"));
    expect(text).toMatch(/HIGH/);
    expect(text.indexOf("docs-site")).toBeLessThan(text.indexOf("Migrate the invoices table"));
    expect(text).toMatch(/^Task\s*$/m);
    expect(text).toMatch(/Dropping a production table/);
    expect(text).toMatch(/psql -c 'drop table invoices'/);
    expect(text).toMatch(/Enter focus/);
  });

  it("shows only the list on short terminals and the detail as a drill-down", () => {
    const list = frame(withSessions(), 100, { height: 12 });
    expect(list).toMatch(/docs-site/);
    expect(list).not.toMatch(/Migrate the invoices table/);
    const detail = frame(reduce(withSessions(), { type: "toggle-detail" }), 100, { height: 12 });
    expect(detail).toMatch(/Migrate the invoices table/);
    expect(detail).not.toMatch(/docs-site/);
  });

  it("adds a column header and a terminal column when the list has the width", () => {
    const wide = frame(withSessions(), 110);
    expect(wide).toMatch(/SESSION\s+STATUS\s+SEEN\s+TERMINAL/);
    expect(rowOf(wide, "billing-api")).toMatch(/tmux %2/);
    expect(rowOf(frame(withSessions(), 70), "billing-api")).not.toMatch(/tmux %2/);
  });

  it("keeps the task out of the list and shows it only in the detail", () => {
    for (const width of [110, 160]) {
      const text = frame(withSessions(), width);
      expect(rowOf(text, "billing-api")).toMatch(/Waiting for a permission decision/);
      expect(rowOf(text, "billing-api")).not.toMatch(/Migrate the invoices table/);
      expect(text).not.toMatch(/\bTASK\b/);
    }
    const noReason = reduce(withSessions(), { type: "session", session: sessionView({ sessionId: "sess-b-00000001", label: "docs-site", taskSummary: "Rewrite the README" }), at: FIXTURE_NOW });
    expect(rowOf(frame(noReason, 120), "docs-site")).not.toMatch(/Rewrite the README/);
  });

  it("explains how to connect when there are no sessions", () => {
    const empty = reduce(initialState({ bell: true }), { type: "snapshot", snapshot: { sessions: [], now: new Date(FIXTURE_NOW).toISOString(), staleAfterMs: 600_000 } });
    expect(frame(empty, 100)).toMatch(/attention hooks install/);
  });

  it("shows a degraded banner when the model is unavailable and an offline banner when disconnected", () => {
    const degraded = reduce(withSessions(), { type: "health", health: { ...HEALTH, model: { ...HEALTH.model, reachable: false } } });
    expect(frame(degraded, 120)).toMatch(/rule-based only/);
    expect(frame(degraded, 120, { classifierEnabled: false })).not.toMatch(/Local model unavailable/);
    const offline = reduce(withSessions(), { type: "connection", connection: "offline", retryAt: FIXTURE_NOW + 4000 });
    expect(frame(offline, 120)).toMatch(/offline.*retry in 4s/i);
  });

  it("renders the help overlay and the label query prompt", () => {
    expect(frame(reduce(withSessions(), { type: "toggle-help" }), 100)).toMatch(/Keyboard/);
    const typing = reduce(reduce(withSessions(), { type: "label-start" }), { type: "label-input", text: "bil" });
    expect(frame(typing, 100)).toMatch(/\/bil/);
  });

  it("stays readable without colour or unicode", () => {
    const text = frame(withSessions(), 120);
    expect(text).not.toMatch(/\u001b\[/);
    expect(text).toMatch(/> /);
    expect(text).toMatch(/\[!\]/);
  });
});

describe("Screen on narrow terminals", () => {
  function linesOf(text: string): string[] {
    return text.split("\n");
  }

  it("wraps the header and footer instead of truncating them", () => {
    const text = frame(withSessions(), 40);
    expect(text).toMatch(/bell on/);
    expect(text).toMatch(/q quit/);
    for (const line of linesOf(text)) expect(line.length).toBeLessThanOrEqual(40);
  });

  it("wraps a long reason onto the next line under the reason column", () => {
    const long = reduce(withSessions(), {
      type: "session",
      session: sessionView({ sessionId: "sess-b-00000001", label: "docs-site", status: "needs_attention", attentionReason: "Asks whether to overwrite the generated changelog for the release" }),
      at: FIXTURE_NOW,
    });
    const text = frame(long, 80);
    expect(text.replace(/\s+/g, " ")).toMatch(/Asks whether to overwrite the generated changelog for the release/);
    for (const line of linesOf(text)) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("wraps the detail lines instead of truncating them", () => {
    const evidence = reduce(withSessions(), {
      type: "session",
      session: sessionView({
        sessionId: "sess-a-00000001",
        label: "billing-api",
        status: "needs_attention",
        priority: "high",
        attentionReason: "Waiting for a permission decision",
        classificationEvidence: ["PermissionRequest for Bash: psql -c 'drop table invoices' on the production cluster"],
      }),
      at: FIXTURE_NOW,
    });
    const text = frame(reduce(evidence, { type: "toggle-detail" }), 50, { height: 40 });
    expect(text.replace(/\s+/g, " ")).toMatch(/on the production cluster/);
  });

  it("keeps the frame within the terminal height when the chrome wraps", () => {
    const offline = reduce(withSessions(), { type: "connection", connection: "offline", retryAt: FIXTURE_NOW + 4000 });
    const text = frame(offline, 40, { height: 20 });
    expect(linesOf(text).length).toBeLessThanOrEqual(20);
    expect(text).toMatch(/q quit/);
  });
});

describe("theme", () => {
  it("detects unicode support from the locale and terminal", () => {
    expect(supportsUnicode({ LANG: "en_US.UTF-8", TERM: "xterm-256color" }, "linux")).toBe(true);
    expect(supportsUnicode({ LANG: "C", TERM: "xterm" }, "linux")).toBe(false);
    expect(supportsUnicode({ LANG: "en_US.UTF-8", TERM: "linux" }, "linux")).toBe(false);
    expect(supportsUnicode({ LC_ALL: "C", LANG: "en_US.UTF-8" }, "linux")).toBe(false);
    expect(supportsUnicode({}, "darwin")).toBe(true);
  });

  it("uses ASCII glyphs and no colours in the plain theme", () => {
    expect(plain.glyphs.selected).toBe(">");
    expect(plain.color("red")).toBeUndefined();
    expect(createTheme({ color: true, unicode: true }).color("red")).toBe("red");
  });
});

describe("Screen while connecting", () => {
  it("says it is connecting instead of showing an empty detail pane", () => {
    const text = frame(initialState({ bell: true }), 120);
    expect(text).toMatch(/Connecting to the receiver/);
    expect(text).not.toMatch(/No session selected/);
  });
});

describe("AI confidence", () => {
  function aiState(): TuiState {
    const session = sessionView({
      sessionId: "sess-ai-00000001",
      label: "billing-api",
      status: "completed",
      priority: "medium",
      attentionReason: "Asks whether to drop the backup table",
      classificationSource: "ai",
      classificationConfidence: 0.72,
      taskSeverity: "critical",
      taskSeveritySource: "ai",
      taskSeverityReason: "Schema change on production",
      taskSeverityConfidence: 0.85,
    });
    return reduce(initialState({ bell: true }), { type: "snapshot", snapshot: { sessions: [session], now: new Date(FIXTURE_NOW).toISOString(), staleAfterMs: 600_000 } });
  }

  it("shows the attention and task-severity confidence in the detail", () => {
    const text = frame(aiState(), 140);
    expect(text).toMatch(/Asks whether to drop the backup table[\s\S]*\[AI confidence 72%\]/);
    expect(text).toMatch(/Critical risk: Schema change on production[\s\S]*\[AI confidence 85%\]/);
  });

  it("shows the attention confidence on the row so it is visible without opening the detail", () => {
    const text = frame(aiState(), 80);
    expect(text).toMatch(/!critical AI confidence 72%/);
  });

  it("marks rule-based verdicts as observed in the detail", () => {
    const observed = reduce(withSessions(), { type: "move", delta: 0 });
    expect(frame(observed, 140)).toMatch(/Critical risk: Dropping a production table[\s\S]*Observed/);
  });
});
