import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { normalizeHookEvent } from "@/core/events/normalize";
import { openStore } from "@/core/persistence/store";
import { reduceSession } from "@/core/sessions/state-machine";

const AT = "2026-10-09T10:00:00.000Z";
const LATER = "2026-10-09T10:01:00.000Z";

function normalized(raw: Record<string, unknown>, at = AT) {
  const result = normalizeHookEvent({ session_id: "sess-terminal-0001", cwd: "/home/ada/proj", ...raw }, at);
  if (!result.ok) throw new Error(result.reason);
  return result.event;
}

describe("terminal identity on sessions", () => {
  it("carries a sanitised terminal from the hook payload into the normalized event", () => {
    const event = normalized({ hook_event_name: "SessionStart", source: "startup", terminal: { tmux: { socket: "/tmp/tmux-1000/default", pane: "%3" }, pid: "nope" } });
    expect(event.terminal).toEqual({ tmux: { socket: "/tmp/tmux-1000/default", pane: "%3" } });
  });

  it("accepts the event and leaves terminal empty when the terminal object is garbage", () => {
    const result = normalizeHookEvent({ session_id: "sess-terminal-0001", hook_event_name: "Stop", terminal: "`id`" }, AT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.terminal).toBeNull();
  });

  it("keeps the latest terminal and updates it when the session reappears in another pane", () => {
    const first = reduceSession(null, normalized({ hook_event_name: "SessionStart", terminal: { tmux: { socket: "/tmp/t", pane: "%1" } } }));
    expect(first.terminal).toEqual({ tmux: { socket: "/tmp/t", pane: "%1" } });
    const noTerminal = reduceSession(first, normalized({ hook_event_name: "UserPromptSubmit", prompt: "hi" }, LATER));
    expect(noTerminal.terminal).toEqual({ tmux: { socket: "/tmp/t", pane: "%1" } });
    const moved = reduceSession(noTerminal, normalized({ hook_event_name: "SessionStart", source: "resume", terminal: { tmux: { socket: "/tmp/t", pane: "%7" } } }, LATER));
    expect(moved.terminal).toEqual({ tmux: { socket: "/tmp/t", pane: "%7" } });
  });

  it("persists the terminal and migrates a database created before the column existed", () => {
    const path = join(mkdtempSync(join(tmpdir(), "attention-terminal-")), "old.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, label TEXT, started_at TEXT, last_seen_at TEXT NOT NULL, last_event_type TEXT,
      status TEXT NOT NULL, priority TEXT NOT NULL, attention_reason TEXT, classification_confidence REAL,
      classification_source TEXT NOT NULL, classified_at TEXT, classification_evidence TEXT NOT NULL DEFAULT '[]',
      classification_error TEXT, ended_at TEXT, recent_failure_times TEXT NOT NULL DEFAULT '[]', pending_permission_tool_use_id TEXT)`);
    old.exec(`INSERT INTO sessions (session_id, last_seen_at, status, priority, classification_source) VALUES ('sess-legacy-0001', '${AT}', 'working', 'none', 'rule')`);
    old.close();

    const store = openStore({ path, eventHistoryLimit: 10 });
    expect(store.getSession("sess-legacy-0001")?.terminal).toBeNull();
    const session = reduceSession(null, normalized({ hook_event_name: "SessionStart", terminal: { kitty: { windowId: "4" }, tty: "/dev/pts/2" } }));
    store.upsertSession(session);
    expect(store.getSession("sess-terminal-0001")?.terminal).toEqual({ kitty: { windowId: "4" }, tty: "/dev/pts/2" });
    store.close();

    const reopened = openStore({ path, eventHistoryLimit: 10 });
    expect(reopened.getSession("sess-terminal-0001")?.terminal).toEqual({ kitty: { windowId: "4" }, tty: "/dev/pts/2" });
    reopened.close();
  });
});
