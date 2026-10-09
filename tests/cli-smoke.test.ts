import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BIN = join(import.meta.dirname, "..", "dist", "cli", "main.js");
const HOOK = join(import.meta.dirname, "..", "dist", "hook", "main.js");
const PORT = 40_000 + Math.floor(Math.random() * 5_000);

function isolatedEnv(home: string): Record<string, string> {
  return { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: home, RECEIVER_PORT: String(PORT), NO_COLOR: "1" };
}

function run(args: string[], env: Record<string, string>, input?: string) {
  return spawnSync(process.execPath, [BIN, ...args], { env, input, encoding: "utf8", timeout: 20_000 });
}

describe.runIf(existsSync(BIN))("built binary", () => {
  const home = mkdtempSync(join(tmpdir(), "attention-smoke-"));
  const env = isolatedEnv(home);
  let receiver: ReturnType<typeof spawn>;

  beforeAll(async () => {
    receiver = spawn(process.execPath, [BIN, "receiver"], { env, stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      if (run(["list", "--json"], env).status === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("receiver did not start");
  });

  afterAll(() => {
    receiver.kill("SIGTERM");
  });

  it("prints its version and usage without warnings", () => {
    const version = run(["--version"], env);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(version.stderr).toBe("");
    expect(run(["--help"], env).stdout).toMatch(/attention list/);
    expect(run(["frobnicate"], env).status).toBe(2);
  });

  it("forwards a hook event and lists it as stable JSON without the sqlite warning", () => {
    const hook = spawnSync(process.execPath, [HOOK], {
      env: { ...env, TMUX: "/tmp/tmux-1000/default,1,0", TMUX_PANE: "%9" },
      input: JSON.stringify({ session_id: "sess-smoke-000001", hook_event_name: "Notification", notification_type: "idle_prompt", cwd: "/w/smoke" }),
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(hook.status).toBe(0);
    const list = run(["list", "--json"], env);
    expect(list.status).toBe(0);
    expect(list.stderr).not.toMatch(/ExperimentalWarning/);
    const json = JSON.parse(list.stdout) as { version: number; sessions: Array<{ id: string; status: string; terminal: { tmux?: unknown } }> };
    expect(json.version).toBe(1);
    expect(json.sessions[0]).toMatchObject({ id: "sess-smoke-000001", status: "needs_attention", terminal: { tmux: { socket: "/tmp/tmux-1000/default", pane: "%9" } } });
  });

  it("reports missing hooks from doctor as misconfiguration", () => {
    const doctor = run(["doctor", "--json"], { ...env, CLAUDE_SETTINGS_PATH: join(home, "none.json") });
    expect(doctor.status).toBe(2);
    expect((JSON.parse(doctor.stdout) as { checks: Array<{ id: string; status: string }> }).checks.find((c) => c.id === "hooks")?.status).toBe("fail");
  });

  it("refuses to open the UI without a terminal", () => {
    const tui = run([], env);
    expect(tui.status).toBe(2);
    expect(tui.stderr).toMatch(/interactive terminal/);
  });
});
