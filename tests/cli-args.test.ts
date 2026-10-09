import { describe, expect, it } from "vitest";
import { parseCli } from "@/cli/args";

describe("parseCli", () => {
  it("defaults to the TUI", () => {
    expect(parseCli([])).toMatchObject({ ok: true, command: "tui", flags: { color: true, keepRunning: false } });
    expect(parseCli(["--no-color", "--keep-running", "--no-bell"])).toMatchObject({ ok: true, command: "tui", flags: { color: false, keepRunning: true, bell: false } });
  });

  it("handles --version and --help anywhere", () => {
    expect(parseCli(["--version"])).toMatchObject({ ok: true, command: "version" });
    expect(parseCli(["-v"])).toMatchObject({ ok: true, command: "version" });
    expect(parseCli(["--help"])).toMatchObject({ ok: true, command: "help", topic: null });
    expect(parseCli(["list", "--help"])).toMatchObject({ ok: true, command: "help", topic: "list" });
    expect(parseCli(["help", "hooks"])).toMatchObject({ ok: true, command: "help", topic: "hooks" });
  });

  it("parses list filters and json output", () => {
    expect(parseCli(["list", "--json", "--status", "needs_attention,error", "--min-priority", "high", "--all"])).toMatchObject({
      ok: true,
      command: "list",
      flags: { json: true, status: "needs_attention,error", minPriority: "high", all: true },
    });
  });

  it("parses hooks subcommands and rejects unknown ones", () => {
    expect(parseCli(["hooks", "install"])).toMatchObject({ ok: true, command: "hooks", action: "install" });
    expect(parseCli(["hooks"])).toMatchObject({ ok: true, command: "hooks", action: "status" });
    expect(parseCli(["hooks", "frobnicate"])).toMatchObject({ ok: false, exitCode: 2 });
  });

  it("requires a target for focus", () => {
    expect(parseCli(["focus", "billing"])).toMatchObject({ ok: true, command: "focus", target: "billing" });
    expect(parseCli(["focus"])).toMatchObject({ ok: false, exitCode: 2 });
  });

  it("parses setup, receiver and doctor flags", () => {
    expect(parseCli(["setup", "--yes"])).toMatchObject({ ok: true, command: "setup", flags: { yes: true } });
    expect(parseCli(["setup", "-y"])).toMatchObject({ ok: true, command: "setup", flags: { yes: true } });
    expect(parseCli(["receiver", "--port", "5000"])).toMatchObject({ ok: true, command: "receiver", flags: { port: 5000 } });
    expect(parseCli(["receiver", "--port", "99999"])).toMatchObject({ ok: false, exitCode: 2 });
    expect(parseCli(["doctor", "--json"])).toMatchObject({ ok: true, command: "doctor", flags: { json: true } });
  });

  it("rejects unknown commands, unknown flags and stray arguments with exit code 2", () => {
    expect(parseCli(["launch"])).toMatchObject({ ok: false, exitCode: 2 });
    expect(parseCli(["list", "--bogus"])).toMatchObject({ ok: false, exitCode: 2 });
    expect(parseCli(["doctor", "extra"])).toMatchObject({ ok: false, exitCode: 2 });
  });
});
