import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClassifierPort } from "@/core/classifier/types";
import { createReceiver, type Receiver } from "@/receiver/server";

const TOKEN = "hook-token-0123456789abcdef";
const HOOK = join(import.meta.dirname, "..", "src", "hook", "main.ts");

const classifier: ClassifierPort = {
  async classify() {
    return null;
  },
  async health() {
    return { reachable: false, modelInstalled: false, model: "fake", url: "http://127.0.0.1:0", error: "stubbed" };
  },
};

function runHook(payload: unknown, env: Record<string, string>) {
  return spawnSync(process.execPath, ["--no-warnings", HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: env.HOME ?? tmpdir(), ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("hook forwarder", () => {
  let receiver: Receiver;
  let configDir: string;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "attention-hook-"));
    writeFileSync(join(configDir, "ingest-token"), TOKEN + "\n", { mode: 0o600 });
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
  });

  afterEach(async () => {
    await receiver.close();
  });

  it("forwards the event with the token from the config dir and attaches terminal identity", async () => {
    const result = runHook(
      { session_id: "sess-hook-00000001", hook_event_name: "SessionStart", source: "startup", cwd: "/home/ada/proj", transcript_path: "/x" },
      {
        ATTENTION_CONFIG_DIR: configDir,
        ATTENTION_RECEIVER_URL: `http://127.0.0.1:${receiver.port}`,
        TMUX: "/tmp/tmux-1000/default,4242,0",
        TMUX_PANE: "%5",
      },
    );
    expect(result.status).toBe(0);
    const detail = (await (await fetch(`http://127.0.0.1:${receiver.port}/api/sessions/sess-hook-00000001`)).json()) as {
      session: { terminal: { tmux?: unknown; cwd?: string } | null; label: string };
    };
    expect(detail.session.label).toBe("proj");
    expect(detail.session.terminal?.tmux).toEqual({ socket: "/tmp/tmux-1000/default", pane: "%5" });
    expect(detail.session.terminal?.cwd).toBe("/home/ada/proj");
  });

  it("exits 0 when the receiver is unreachable or the payload is malformed", () => {
    expect(runHook({ session_id: "sess-hook-00000002", hook_event_name: "Stop" }, { ATTENTION_CONFIG_DIR: configDir, ATTENTION_RECEIVER_URL: "http://127.0.0.1:1" }).status).toBe(0);
    expect(runHook("{not json", { ATTENTION_CONFIG_DIR: configDir, ATTENTION_RECEIVER_URL: `http://127.0.0.1:${receiver.port}` }).status).toBe(0);
  });

  it("is rejected without the right token, still exiting 0", async () => {
    const otherDir = mkdtempSync(join(tmpdir(), "attention-hook-"));
    writeFileSync(join(otherDir, "ingest-token"), "wrong-token\n");
    const result = runHook({ session_id: "sess-hook-00000003", hook_event_name: "SessionStart" }, { ATTENTION_CONFIG_DIR: otherDir, ATTENTION_RECEIVER_URL: `http://127.0.0.1:${receiver.port}` });
    expect(result.status).toBe(0);
    const res = await fetch(`http://127.0.0.1:${receiver.port}/api/sessions/sess-hook-00000003`);
    expect(res.status).toBe(404);
  });
});
