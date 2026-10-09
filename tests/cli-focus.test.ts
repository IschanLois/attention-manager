import { describe, expect, it } from "vitest";
import type { TerminalInfo } from "@/core/terminal";
import { describeFocusResult } from "@/cli/commands/focus";
import { focusSession, planFocus } from "@/cli/focus/select";
import type { Exec, ExecResult, FocusContext, StepOutcome } from "@/cli/focus/types";

type Call = { file: string; args: string[] };

function fakeExec(respond: (call: Call) => ExecResult = () => ({ ok: true, stdout: "" })): Exec & { calls: Call[] } {
  const calls: Call[] = [];
  const exec = (async (file: string, args: string[]) => {
    const call = { file, args };
    calls.push(call);
    return respond(call);
  }) as Exec & { calls: Call[] };
  exec.calls = calls;
  return exec;
}

function fakeRing(outcome: StepOutcome = { ok: true }): FocusContext["ringTty"] & { rung: string[] } {
  const rung: string[] = [];
  const ring = (async (tty: string) => {
    rung.push(tty);
    return outcome;
  }) as FocusContext["ringTty"] & { rung: string[] };
  ring.rung = rung;
  return ring;
}

function ctx(platform: string, env: Record<string, string>, exec: Exec = fakeExec(), ringTty: FocusContext["ringTty"] = fakeRing()): FocusContext {
  return { platform, env, exec, ringTty };
}

const X11 = { DISPLAY: ":0" };
const GNOME_WAYLAND = { WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" };
const TMUX_PANE: TerminalInfo = { tmux: { socket: "/tmp/tmux-1000/default", pane: "%3" }, tty: "/dev/pts/4", pid: 300, ancestors: [200, 100], cwd: "/home/ada/proj" };
const ITERM_ID = "w0t1p2:6E2E1C3A-0D7B-4E5F-9A1B-2C3D4E5F6A7B";

const ids = (info: TerminalInfo, c: FocusContext) => planFocus(info, c).map((step) => step.id);

describe("planFocus", () => {
  it("selects the multiplexer first and then the host terminal and window", () => {
    expect(ids({ ...TMUX_PANE, wezterm: { pane: "12" } }, ctx("linux", X11))).toEqual(["tmux", "wezterm", "x11"]);
  });

  it("uses terminal remote control on Wayland and no generic window step", () => {
    expect(ids({ kitty: { windowId: "4" }, ancestors: [100] }, ctx("linux", GNOME_WAYLAND))).toEqual(["kitty"]);
    expect(ids({ tty: "/dev/pts/1", ancestors: [100] }, ctx("linux", GNOME_WAYLAND))).toEqual([]);
  });

  it("uses sway or Hyprland when that compositor is running", () => {
    expect(ids({ ancestors: [100] }, ctx("linux", { ...GNOME_WAYLAND, SWAYSOCK: "/run/user/1000/sway-ipc.sock" }))).toEqual(["sway"]);
    expect(ids({ ancestors: [100] }, ctx("linux", { ...GNOME_WAYLAND, HYPRLAND_INSTANCE_SIGNATURE: "abc" }))).toEqual(["hyprland"]);
  });

  it("uses AppleScript adapters only on macOS", () => {
    expect(ids({ iterm: { sessionId: ITERM_ID } }, ctx("darwin", {}))).toEqual(["iterm"]);
    expect(ids({ iterm: { sessionId: ITERM_ID } }, ctx("linux", X11))).toEqual([]);
    expect(ids({ termProgram: "Apple_Terminal", tty: "/dev/ttys003" }, ctx("darwin", {}))).toEqual(["apple-terminal"]);
    expect(ids({ ...TMUX_PANE, iterm: { sessionId: ITERM_ID } }, ctx("darwin", {}))).toEqual(["tmux", "iterm"]);
  });

  it("selects screen when the window number is known", () => {
    expect(ids({ screen: { sty: "1234.pts-0.host", window: "2" } }, ctx("linux", {}))).toEqual(["screen"]);
    expect(ids({ screen: { sty: "1234.pts-0.host" } }, ctx("linux", {}))).toEqual([]);
  });

  it("uses X11 window lookup only with a window id or process ancestry", () => {
    expect(ids({ windowId: "41943047" }, ctx("linux", X11))).toEqual(["x11"]);
    expect(ids({ tty: "/dev/pts/1" }, ctx("linux", X11))).toEqual([]);
  });
});

describe("adapter arguments", () => {
  it("drives tmux on the pane's own server and switches the client when the UI shares that server", async () => {
    const exec = fakeExec();
    await focusSession(TMUX_PANE, ctx("linux", { TMUX: "/tmp/tmux-1000/default,999,0" }, exec));
    expect(exec.calls).toEqual([
      { file: "tmux", args: ["-S", "/tmp/tmux-1000/default", "select-window", "-t", "%3"] },
      { file: "tmux", args: ["-S", "/tmp/tmux-1000/default", "select-pane", "-t", "%3"] },
      { file: "tmux", args: ["-S", "/tmp/tmux-1000/default", "switch-client", "-t", "%3"] },
    ]);
  });

  it("does not switch the client when the UI runs outside that tmux server", async () => {
    const exec = fakeExec();
    await focusSession(TMUX_PANE, ctx("linux", {}, exec));
    expect(exec.calls.map((c) => c.args[2])).toEqual(["select-window", "select-pane"]);
  });

  it("builds kitty, wezterm and screen commands", async () => {
    const exec = fakeExec();
    await focusSession({ kitty: { windowId: "4", listenOn: "unix:/tmp/kitty-1" } }, ctx("linux", GNOME_WAYLAND, exec));
    await focusSession({ kitty: { windowId: "5" } }, ctx("linux", GNOME_WAYLAND, exec));
    await focusSession({ wezterm: { pane: "12" } }, ctx("linux", GNOME_WAYLAND, exec));
    await focusSession({ screen: { sty: "1234.pts-0.host", window: "2" } }, ctx("linux", {}, exec));
    expect(exec.calls).toEqual([
      { file: "kitten", args: ["@", "--to", "unix:/tmp/kitty-1", "focus-window", "--match", "id:4"] },
      { file: "kitten", args: ["@", "focus-window", "--match", "id:5"] },
      { file: "wezterm", args: ["cli", "activate-pane", "--pane-id", "12"] },
      { file: "screen", args: ["-S", "1234.pts-0.host", "-X", "select", "2"] },
    ]);
  });

  it("passes iTerm2 and Terminal.app identifiers as AppleScript argv, never inside the script", async () => {
    const exec = fakeExec(() => ({ ok: true, stdout: "focused\n" }));
    await focusSession({ iterm: { sessionId: ITERM_ID } }, ctx("darwin", {}, exec));
    await focusSession({ termProgram: "Apple_Terminal", tty: "/dev/ttys003" }, ctx("darwin", {}, exec));
    expect(exec.calls[0]!.file).toBe("osascript");
    expect(exec.calls[0]!.args.slice(-1)).toEqual(["6E2E1C3A-0D7B-4E5F-9A1B-2C3D4E5F6A7B"]);
    expect(exec.calls[0]!.args.join(" ")).not.toContain("6E2E1C3A-0D7B-4E5F-9A1B-2C3D4E5F6A7B\"");
    expect(exec.calls[1]!.args.slice(-1)).toEqual(["/dev/ttys003"]);
    for (const call of exec.calls) expect(call.args[0]).toBe("-e");
  });

  it("reports an AppleScript 'not found' as a failure", async () => {
    const exec = fakeExec(() => ({ ok: true, stdout: "not found\n" }));
    const result = await focusSession({ iterm: { sessionId: ITERM_ID } }, ctx("darwin", {}, exec));
    expect(result.kind).toBe("failed");
  });

  it("activates the X11 window id and falls back to wmctrl with a hex id", async () => {
    const exec = fakeExec((call) => (call.file === "xdotool" ? { ok: false, kind: "missing", message: "xdotool not found" } : { ok: true, stdout: "" }));
    const result = await focusSession({ windowId: "41943047" }, ctx("linux", X11, exec));
    expect(result.kind).toBe("focused");
    expect(exec.calls).toEqual([
      { file: "xdotool", args: ["windowactivate", "41943047"] },
      { file: "wmctrl", args: ["-i", "-a", "0x02800007"] },
    ]);
  });

  it("looks up the X11 window from the process ancestry", async () => {
    const exec = fakeExec((call) => {
      if (call.args[0] === "search") return call.args[2] === "100" ? { ok: true, stdout: "41943047\n41943050\n" } : { ok: false, kind: "exit", message: "exit 1" };
      return { ok: true, stdout: "" };
    });
    const result = await focusSession({ ancestors: [200, 100] }, ctx("linux", X11, exec));
    expect(result.kind).toBe("focused");
    expect(exec.calls).toEqual([
      { file: "xdotool", args: ["search", "--pid", "200"] },
      { file: "xdotool", args: ["search", "--pid", "100"] },
      { file: "xdotool", args: ["windowactivate", "41943047"] },
    ]);
  });

  it("falls back to wmctrl's window list when xdotool is not installed", async () => {
    const exec = fakeExec((call) => {
      if (call.file === "xdotool") return { ok: false, kind: "missing", message: "xdotool is not installed" };
      if (call.args[0] === "-lp") return { ok: true, stdout: "0x03a00007  0 4321   host editor\n0x04400003  1 100    host Terminal\n" };
      return { ok: true, stdout: "" };
    });
    const result = await focusSession({ ancestors: [200, 100] }, ctx("linux", X11, exec));
    expect(result.kind).toBe("focused");
    expect(exec.calls.slice(1)).toEqual([
      { file: "wmctrl", args: ["-lp"] },
      { file: "wmctrl", args: ["-i", "-a", "0x04400003"] },
    ]);
  });

  it("focuses by pid through swaymsg and hyprctl", async () => {
    const exec = fakeExec();
    await focusSession({ ancestors: [100] }, ctx("linux", { ...GNOME_WAYLAND, SWAYSOCK: "/s" }, exec));
    await focusSession({ ancestors: [100] }, ctx("linux", { ...GNOME_WAYLAND, HYPRLAND_INSTANCE_SIGNATURE: "x" }, exec));
    expect(exec.calls).toEqual([
      { file: "swaymsg", args: ["[pid=100]", "focus"] },
      { file: "hyprctl", args: ["dispatch", "focuswindow", "pid:100"] },
    ]);
  });
});

describe("focusSession results", () => {
  it("is focused when the multiplexer succeeds even if the host step fails, and notes the failure", async () => {
    const exec = fakeExec((call) => (call.file === "wezterm" ? { ok: false, kind: "exit", message: "no such pane" } : { ok: true, stdout: "" }));
    const result = await focusSession({ ...TMUX_PANE, wezterm: { pane: "12" } }, ctx("linux", {}, exec));
    expect(result.kind).toBe("focused");
    if (result.kind === "focused") {
      expect(result.via).toEqual(["tmux"]);
      expect(result.notes.join(" ")).toMatch(/wezterm.*no such pane/);
    }
  });

  it("fails with every reason and a copyable command when all steps fail", async () => {
    const exec = fakeExec(() => ({ ok: false, kind: "timeout", message: "timed out after 1500ms" }));
    const result = await focusSession(TMUX_PANE, ctx("linux", {}, exec));
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toMatch(/tmux: timed out/);
      expect(result.hint).toContain("tmux -S /tmp/tmux-1000/default select-window -t %3");
    }
  });

  it("is unsupported with tty, pid and cwd when nothing can focus the session", async () => {
    const result = await focusSession({ tty: "/dev/pts/4", pid: 300, cwd: "/home/ada/my proj" }, ctx("linux", {}));
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") {
      expect(result.hint).toContain("/dev/pts/4");
      expect(result.hint).toContain("pid 300");
      expect(result.hint).toContain("cd '/home/ada/my proj'");
    }
  });

  it("says plainly that Wayland has no generic focus API", async () => {
    const result = await focusSession({ tty: "/dev/pts/4" }, ctx("linux", GNOME_WAYLAND));
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") expect(result.hint).toMatch(/Wayland has no generic window-focus API/);
  });

  it("is unsupported when the session has no terminal identity at all", async () => {
    const result = await focusSession(null, ctx("linux", X11));
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") expect(result.hint).toMatch(/no terminal information/i);
  });
});

describe("terminal highlight", () => {
  it("rings the session's tty after a successful focus", async () => {
    const ring = fakeRing();
    const result = await focusSession(TMUX_PANE, ctx("linux", {}, fakeExec(), ring));
    expect(ring.rung).toEqual(["/dev/pts/4"]);
    expect(result).toMatchObject({ kind: "focused", highlighted: "/dev/pts/4" });
  });

  it("rings the tty when nothing can focus the session or every focus step fails", async () => {
    const unsupported = await focusSession({ tty: "/dev/pts/4" }, ctx("linux", GNOME_WAYLAND));
    expect(unsupported).toMatchObject({ kind: "unsupported", highlighted: "/dev/pts/4" });
    const failing = fakeExec(() => ({ ok: false, kind: "exit", message: "exit 1" }));
    const failed = await focusSession(TMUX_PANE, ctx("linux", {}, failing));
    expect(failed).toMatchObject({ kind: "failed", highlighted: "/dev/pts/4" });
  });

  it("does not ring without a tty and keeps a successful focus when the ring fails", async () => {
    const ring = fakeRing();
    await focusSession({ windowId: "41943047" }, ctx("linux", X11, fakeExec(), ring));
    expect(ring.rung).toEqual([]);
    const result = await focusSession(TMUX_PANE, ctx("linux", {}, fakeExec(), fakeRing({ ok: false, reason: "EACCES" })));
    expect(result.kind).toBe("focused");
    expect(result.highlighted).toBeUndefined();
  });

  it("tells the user which terminal was marked", () => {
    expect(describeFocusResult({ kind: "focused", via: ["x11"], notes: [], highlighted: "/dev/pts/3" }, "api")).toMatch(/Focused api via x11.*bell.*pts\/3/);
    expect(describeFocusResult({ kind: "unsupported", hint: "Switch to it manually.", highlighted: "/dev/pts/3" }, "api")).toMatch(/^Rang the bell on pts\/3.*Switch to it manually/);
    expect(describeFocusResult({ kind: "unsupported", hint: "Switch to it manually." }, "api")).not.toMatch(/bell/);
  });
});
