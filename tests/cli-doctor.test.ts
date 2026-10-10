import { describe, expect, it } from "vitest";
import { doctorChecks, doctorExitCode, type DoctorInputs } from "@/cli/doctor";
import { sessionView } from "./fixtures/sessions";

const HEALTH = {
  ok: true,
  app: "attention-manager",
  version: "0.1.0",
  uptimeSeconds: 10,
  receiver: { host: "127.0.0.1", port: 4318, sseClients: 1 },
  sqlite: { ok: true, path: "/s/attention.db", error: null },
  model: { reachable: true, modelInstalled: true, model: "qwen3:1.7b", url: "http://127.0.0.1:11434", error: null },
  lastEventAt: null,
  lastClassificationError: null,
  sessionCount: 2,
};

function inputs(overrides: Partial<DoctorInputs> = {}): DoctorInputs {
  return {
    platform: "linux",
    nodeVersion: "24.1.0",
    configError: null,
    tokenPresent: true,
    hooks: { state: "installed", events: [], commands: [], reason: null },
    classifierEnabled: true,
    model: "qwen3:1.7b",
    health: HEALTH,
    directModel: null,
    ingestStatus: 200,
    currentTerminal: { backends: ["tmux", "x11"], wayland: false },
    sessions: [sessionView({ terminal: { tmux: { socket: "/t", pane: "%1" } } }), sessionView({ sessionId: "sess-fixture-0002" })],
    focusable: (s) => s.terminal !== null,
    ...overrides,
  };
}

const byId = (checks: ReturnType<typeof doctorChecks>, id: string) => checks.find((c) => c.id === id)!;

describe("doctorChecks", () => {
  it("passes a healthy setup and reports focusable sessions and the detected backend", () => {
    const checks = doctorChecks(inputs());
    expect(checks.every((c) => c.status !== "fail")).toBe(true);
    expect(byId(checks, "terminal").detail).toMatch(/tmux \+ x11/);
    expect(byId(checks, "sessions").detail).toMatch(/1 of 2 sessions can be focused/);
    expect(doctorExitCode(checks)).toBe(0);
  });

  it("treats missing hooks, a missing token and a bad config as misconfiguration (exit 2)", () => {
    expect(doctorExitCode(doctorChecks(inputs({ hooks: { state: "absent", events: [], commands: [], reason: null } })))).toBe(2);
    expect(doctorExitCode(doctorChecks(inputs({ hooks: { state: "stale", events: ["Stop"], commands: [], reason: "moved" } })))).toBe(2);
    expect(doctorExitCode(doctorChecks(inputs({ tokenPresent: false })))).toBe(2);
    expect(doctorExitCode(doctorChecks(inputs({ configError: "bad json" })))).toBe(2);
    expect(byId(doctorChecks(inputs({ hooks: { state: "absent", events: [], commands: [], reason: null } })), "hooks").hint).toMatch(/attention hooks install/);
  });

  it("treats a rejected ingest token and a broken database as errors (exit 1)", () => {
    expect(doctorExitCode(doctorChecks(inputs({ ingestStatus: 401 })))).toBe(1);
    expect(doctorExitCode(doctorChecks(inputs({ health: { ...HEALTH, sqlite: { ok: false, path: "/s", error: "disk I/O" } } })))).toBe(1);
  });

  it("only warns when the receiver is stopped or the model is unavailable", () => {
    const stopped = doctorChecks(inputs({ health: null, ingestStatus: null, directModel: { reachable: false, modelInstalled: false } }));
    expect(byId(stopped, "receiver").status).toBe("warn");
    expect(byId(stopped, "model").status).toBe("warn");
    expect(doctorExitCode(stopped)).toBe(0);
    const missingModel = doctorChecks(inputs({ health: { ...HEALTH, model: { ...HEALTH.model, modelInstalled: false } } }));
    expect(byId(missingModel, "model").hint).toBe("ollama pull qwen3:1.7b");
  });

  it("fails as misconfiguration on a Node older than 24 and tells the user which version to install", () => {
    const old = doctorChecks(inputs({ nodeVersion: "22.12.0" }));
    expect(byId(old, "node")).toMatchObject({ status: "fail", misconfiguration: true, detail: expect.stringMatching(/22\.12\.0/), hint: expect.stringMatching(/Node\.js 24/) });
    expect(doctorExitCode(old)).toBe(2);
    expect(byId(doctorChecks(inputs({ nodeVersion: "24.1.0" })), "node")).toMatchObject({ status: "ok", detail: "v24.1.0" });
    expect(byId(doctorChecks(inputs({ nodeVersion: "25.0.0" })), "node").status).toBe("ok");
  });

  it("reports the model as disabled when local AI is off", () => {
    expect(byId(doctorChecks(inputs({ classifierEnabled: false })), "model")).toMatchObject({ status: "ok", detail: expect.stringMatching(/disabled/) });
  });

  it("is honest about Wayland and mentions macOS Automation", () => {
    const wayland = doctorChecks(inputs({ currentTerminal: { backends: [], wayland: true } }));
    expect(byId(wayland, "terminal")).toMatchObject({ status: "warn", detail: expect.stringMatching(/Wayland has no generic window-focus API/) });
    const mac = doctorChecks(inputs({ platform: "darwin", currentTerminal: { backends: ["iterm"], wayland: false } }));
    expect(byId(mac, "terminal").hint).toMatch(/Automation/);
  });
});
