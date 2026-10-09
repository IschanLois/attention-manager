import { describe, expect, it } from "vitest";
import { ensureReceiver, LifecycleError, type Probe } from "@/cli/lifecycle";

const OURS: Probe = { state: "ours", sseClients: 0 };

function sequence(...probes: Probe[]): () => Promise<Probe> {
  let index = 0;
  return async () => probes[Math.min(index++, probes.length - 1)]!;
}

describe("ensureReceiver", () => {
  it("attaches to a running receiver without spawning", async () => {
    let spawned = 0;
    const result = await ensureReceiver({ port: 4318, probe: sequence(OURS), spawn: () => ((spawned += 1), { exited: () => null }), pollMs: 1, waitMs: 50 });
    expect(result).toEqual({ startedByUs: false });
    expect(spawned).toBe(0);
  });

  it("spawns one when none is running and waits until it answers", async () => {
    let spawned = 0;
    const result = await ensureReceiver({
      port: 4318,
      probe: sequence({ state: "absent" }, { state: "absent" }, OURS),
      spawn: () => ((spawned += 1), { exited: () => null }),
      pollMs: 1,
      waitMs: 500,
    });
    expect(result).toEqual({ startedByUs: true });
    expect(spawned).toBe(1);
  });

  it("refuses to start when another program owns the port", async () => {
    const attempt = ensureReceiver({ port: 4318, probe: sequence({ state: "foreign", detail: "HTTP 404" }), spawn: () => ({ exited: () => null }), pollMs: 1, waitMs: 50 });
    await expect(attempt).rejects.toBeInstanceOf(LifecycleError);
    await expect(attempt).rejects.toMatchObject({ exitCode: 2, message: expect.stringMatching(/port 4318 is in use by another program/i) });
  });

  it("reports a spawned receiver that exits early, pointing at its log", async () => {
    const attempt = ensureReceiver({
      port: 4318,
      probe: sequence({ state: "absent" }),
      spawn: () => ({ exited: () => 2 }),
      pollMs: 1,
      waitMs: 200,
      logFile: "/tmp/receiver.log",
    });
    await expect(attempt).rejects.toMatchObject({ exitCode: 1, message: expect.stringMatching(/exited with code 2.*\/tmp\/receiver\.log/) });
  });

  it("gives up when the spawned receiver never answers", async () => {
    const attempt = ensureReceiver({ port: 4318, probe: sequence({ state: "absent" }), spawn: () => ({ exited: () => null }), pollMs: 1, waitMs: 20 });
    await expect(attempt).rejects.toMatchObject({ exitCode: 1, message: expect.stringMatching(/did not become ready/) });
  });
});
