import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFocus } from "@/cli/commands/focus";
import { runHooks } from "@/cli/commands/hooks";
import { matchSession, runList, toListJson } from "@/cli/commands/list";
import { DEFAULT_CONFIG } from "@/cli/config";
import type { CliContext } from "@/cli/context";
import type { Exec } from "@/cli/focus/types";
import { resolvePaths } from "@/cli/paths";
import type { ClassifierPort } from "@/core/classifier/types";
import { createReceiver, type Receiver } from "@/receiver/server";
import { FIXTURE_NOW, sessionView } from "./fixtures/sessions";

const TOKEN = "cmd-token-0123456789abcdef";

const classifier: ClassifierPort = {
  async classify() {
    return null;
  },
  async health() {
    return { reachable: false, modelInstalled: false, model: "fake", url: "http://127.0.0.1:0", error: "stubbed" };
  },
};

function context(overrides: Partial<CliContext> = {}): CliContext & { output: string[]; errors: string[]; calls: Array<[string, string[]]> } {
  const home = mkdtempSync(join(tmpdir(), "attention-cmd-"));
  const output: string[] = [];
  const errors: string[] = [];
  const calls: Array<[string, string[]]> = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, args]);
    return { ok: true, stdout: "" };
  };
  return {
    platform: "linux",
    env: {},
    paths: resolvePaths({ platform: "linux", env: {}, home, appName: "attention-manager" }),
    config: DEFAULT_CONFIG,
    configExists: true,
    settingsPath: join(home, ".claude", "settings.json"),
    hookSpec: { nodePath: "/usr/bin/node", hookScript: "/opt/attention-manager/dist/hook/main.js" },
    receiverUrl: "http://127.0.0.1:1",
    color: false,
    isTTY: false,
    exec,
    ringTty: async () => ({ ok: true }),
    writeTty: async () => ({ ok: true }),
    out: (line) => output.push(line),
    err: (line) => errors.push(line),
    ...overrides,
    output,
    errors,
    calls,
  };
}

describe("matchSession", () => {
  const sessions = [
    sessionView({ sessionId: "aaaa1111-0000", label: "billing-api" }),
    sessionView({ sessionId: "aaaa2222-0000", label: "billing-web" }),
    sessionView({ sessionId: "bbbb3333-0000", label: "docs" }),
  ];

  it("matches an exact id, a unique id prefix, an exact label or a unique label prefix", () => {
    expect(matchSession(sessions, "bbbb3333-0000")).toMatchObject({ kind: "match", session: { label: "docs" } });
    expect(matchSession(sessions, "aaaa2")).toMatchObject({ kind: "match", session: { label: "billing-web" } });
    expect(matchSession(sessions, "DOCS")).toMatchObject({ kind: "match", session: { sessionId: "bbbb3333-0000" } });
    expect(matchSession(sessions, "billing-a")).toMatchObject({ kind: "match", session: { sessionId: "aaaa1111-0000" } });
  });

  it("reports ambiguous and missing targets", () => {
    expect(matchSession(sessions, "billing")).toMatchObject({ kind: "ambiguous", candidates: ["billing-api", "billing-web"] });
    expect(matchSession(sessions, "aaaa")).toMatchObject({ kind: "ambiguous" });
    expect(matchSession(sessions, "nope")).toEqual({ kind: "none" });
  });
});

describe("toListJson", () => {
  it("projects sessions into a stable, versioned shape", () => {
    const json = toListJson(
      [sessionView({ status: "needs_attention", priority: "high", attentionReason: "Waiting", terminal: { tmux: { socket: "/tmp/t", pane: "%1" } } })],
      FIXTURE_NOW,
      () => true,
    );
    expect(json).toEqual({
      version: 1,
      generatedAt: "2026-10-09T10:00:00.000Z",
      sessions: [
        {
          id: "sess-fixture-0001",
          label: "proj",
          status: "needs_attention",
          priority: "high",
          reason: "Waiting",
          reasonSource: "rule",
          reasonConfidence: null,
          taskSeverity: "none",
          taskSeveritySource: "rule",
          taskSeverityConfidence: null,
          taskSeverityReason: null,
          taskSummary: null,
          lastSeenAt: "2026-10-09T09:59:00.000Z",
          startedAt: "2026-10-09T09:00:00.000Z",
          endedAt: null,
          stale: false,
          focusable: true,
          terminal: { tmux: { socket: "/tmp/t", pane: "%1" } },
        },
      ],
    });
  });
});

describe("commands against a live receiver", () => {
  let receiver: Receiver;
  let url: string;

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`${url}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-attention-token": TOKEN },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);
  }

  beforeEach(async () => {
    receiver = await createReceiver({
      host: "127.0.0.1",
      port: 0,
      databasePath: ":memory:",
      ingestToken: TOKEN,
      maxBodyBytes: 262_144,
      eventHistoryLimit: 50,
      staleAfterMs: 600_000,
      dedupeWindowMs: 0,
      rateLimit: { perSessionPerMinute: 1000, globalPerMinute: 1000 },
      classifier,
      logLevel: "error",
    });
    url = `http://127.0.0.1:${receiver.port}`;
    await post({ session_id: "sess-alpha-000001", hook_event_name: "SessionStart", cwd: "/w/alpha", terminal: { tmux: { socket: "/tmp/tmux-1/default", pane: "%4" } } });
    await post({ session_id: "sess-alpha-000001", hook_event_name: "PermissionRequest", cwd: "/w/alpha", tool_name: "Bash", tool_input: { command: "rm -rf build" } });
    await post({ session_id: "sess-beta-0000001", hook_event_name: "SessionStart", cwd: "/w/beta" });
  });

  afterEach(async () => {
    await receiver.close();
  });

  it("lists sessions as JSON in attention order, honouring filters", async () => {
    const ctx = context({ receiverUrl: url });
    expect(await runList(ctx, { json: true })).toBe(0);
    const all = JSON.parse(ctx.output.join("\n")) as { version: number; sessions: Array<{ id: string; focusable: boolean; status: string }> };
    expect(all.version).toBe(1);
    expect(all.sessions.map((s) => [s.id, s.status, s.focusable])).toEqual([
      ["sess-alpha-000001", "needs_attention", true],
      ["sess-beta-0000001", "starting", false],
    ]);

    const filtered = context({ receiverUrl: url });
    expect(await runList(filtered, { json: true, minPriority: "high" })).toBe(0);
    expect((JSON.parse(filtered.output.join("\n")) as { sessions: unknown[] }).sessions).toHaveLength(1);
  });

  it("prints a readable table without --json and rejects bad filters with exit 2", async () => {
    const ctx = context({ receiverUrl: url });
    expect(await runList(ctx, {})).toBe(0);
    expect(ctx.output.join("\n")).toMatch(/alpha.*Needs input/);
    const bad = context({ receiverUrl: url });
    expect(await runList(bad, { status: "bogus" })).toBe(2);
    expect(bad.errors.join("\n")).toMatch(/unknown --status value/);
  });

  it("exits 1 with a hint when the receiver is not running", async () => {
    const ctx = context({ receiverUrl: "http://127.0.0.1:1" });
    expect(await runList(ctx, { json: true })).toBe(1);
    expect(ctx.errors.join("\n")).toMatch(/receiver is not running/i);
    expect(ctx.output).toEqual([]);
  });

  it("focuses a session's tmux pane by label and reports unfocusable ones", async () => {
    const ctx = context({ receiverUrl: url });
    expect(await runFocus(ctx, "alpha")).toBe(0);
    expect(ctx.calls[0]).toEqual(["tmux", ["-S", "/tmp/tmux-1/default", "select-window", "-t", "%4"]]);

    const beta = context({ receiverUrl: url });
    expect(await runFocus(beta, "beta")).toBe(1);
    expect(beta.errors.join("\n")).toMatch(/No terminal information/);

    const missing = context({ receiverUrl: url });
    expect(await runFocus(missing, "gamma")).toBe(1);
  });

  it("exits 2 when the focus target is ambiguous", async () => {
    const ctx = context({ receiverUrl: url });
    expect(await runFocus(ctx, "sess-")).toBe(2);
    expect(ctx.errors.join("\n")).toMatch(/matches more than one session/);
  });
});

describe("hooks command", () => {
  it("installs, reports status and uninstalls with meaningful exit codes", async () => {
    const ctx = context();
    expect(await runHooks(ctx, "status")).toBe(2);
    expect(await runHooks(ctx, "install")).toBe(0);
    const settings = JSON.parse(readFileSync(ctx.settingsPath, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(settings.hooks.Stop![0]!.hooks[0]!.command).toBe('"/usr/bin/node" "/opt/attention-manager/dist/hook/main.js"');
    expect(readFileSync(ctx.paths.tokenFile, "utf8").trim()).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const status = context({ settingsPath: ctx.settingsPath, paths: ctx.paths, hookSpec: { nodePath: "/usr/bin/node", hookScript: "/opt/attention-manager/dist/hook/main.js" } });
    // The hook entry in this test does not exist on disk, so status reports it stale.
    expect(await runHooks(status, "status")).toBe(2);
    expect(status.output.join("\n")).toMatch(/stale/);

    expect(await runHooks(ctx, "uninstall")).toBe(0);
    expect(JSON.parse(readFileSync(ctx.settingsPath, "utf8"))).toEqual({});
  });
});
