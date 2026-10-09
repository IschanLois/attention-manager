import { describe, expect, it } from "vitest";
import { sanitizeTerminal } from "@/core/terminal";
import { collectTerminal, findClaudeProcess, parseProcStat, parsePsTable, type ProcInfo } from "@/hook/collect";
import { minimizePayload } from "@/hook/minimize";

function table(rows: ProcInfo[]): (pid: number) => ProcInfo | null {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  return (pid) => byPid.get(pid) ?? null;
}

// hook (500) -> sh (400) -> claude (300, on /dev/pts/4) -> zsh (200) -> terminal emulator (100) -> init (1)
const LINUX_TREE = table([
  { pid: 500, ppid: 400, comm: "node", tty: null },
  { pid: 400, ppid: 300, comm: "sh", tty: null },
  { pid: 300, ppid: 200, comm: "claude", tty: "/dev/pts/4" },
  { pid: 200, ppid: 100, comm: "zsh", tty: "/dev/pts/4" },
  { pid: 100, ppid: 1, comm: "wezterm-gui", tty: null },
  { pid: 1, ppid: 0, comm: "systemd", tty: null },
]);

describe("sanitizeTerminal", () => {
  it("keeps a well-formed terminal description", () => {
    const info = {
      termProgram: "WezTerm",
      tmux: { socket: "/tmp/tmux-1000/default", pane: "%3" },
      wezterm: { pane: "12" },
      kitty: { windowId: "4", listenOn: "unix:/tmp/kitty-99" },
      iterm: { sessionId: "w0t1p2:6E2E1C3A-0D7B-4E5F-9A1B-2C3D4E5F6A7B" },
      windowId: "41943047",
      tty: "/dev/pts/4",
      pid: 300,
      ancestors: [200, 100],
      cwd: "/home/ada/my project",
      display: "x11",
    };
    expect(sanitizeTerminal(info)).toEqual(info);
  });

  it("drops fields carrying shell metacharacters or control characters, keeping the rest", () => {
    const result = sanitizeTerminal({
      tmux: { socket: "/tmp/tmux-1000/default", pane: "%3; rm -rf ~" },
      wezterm: { pane: "$(reboot)" },
      kitty: { windowId: "4", listenOn: "unix:/tmp/k`id`" },
      termProgram: "evil\u001b[2J",
      tty: "/dev/pts/4 && curl x",
      windowId: "0x1a00007",
      pid: 300,
    });
    expect(result).toEqual({ kitty: { windowId: "4" }, windowId: "0x1a00007", pid: 300 });
  });

  it("drops oversized and wrongly typed values", () => {
    const result = sanitizeTerminal({
      termProgram: "x".repeat(200),
      pid: -5,
      ancestors: [1.5, "2"],
      cwd: "relative/path",
      display: "mir",
      screen: { sty: "1234.pts-0.host", window: "2" },
    });
    expect(result).toEqual({ screen: { sty: "1234.pts-0.host", window: "2" } });
  });

  it("returns null for non-objects and descriptions with nothing usable", () => {
    expect(sanitizeTerminal(undefined)).toBeNull();
    expect(sanitizeTerminal("tmux")).toBeNull();
    expect(sanitizeTerminal([])).toBeNull();
    expect(sanitizeTerminal({ tty: "not a tty" })).toBeNull();
  });
});

describe("process tree", () => {
  it("parses /proc/<pid>/stat including command names with spaces and parentheses", () => {
    expect(parseProcStat("300 (claude) S 200 300 200 34820 ...")).toEqual({ pid: 300, ppid: 200, comm: "claude" });
    expect(parseProcStat("77 (Web (Content)) S 12 77 ...")).toEqual({ pid: 77, ppid: 12, comm: "Web (Content)" });
    expect(parseProcStat("garbage")).toBeNull();
  });

  it("parses the macOS ps table", () => {
    const rows = parsePsTable("  300   200 ttys003  /usr/local/bin/claude\n  200   100 ttys003  -zsh\n  100     1 ??       /Applications/iTerm.app/Contents/MacOS/iTerm2\n");
    expect(rows).toEqual([
      { pid: 300, ppid: 200, comm: "claude", tty: "/dev/ttys003" },
      { pid: 200, ppid: 100, comm: "-zsh", tty: "/dev/ttys003" },
      { pid: 100, ppid: 1, comm: "iTerm2", tty: null },
    ]);
  });

  it("finds the Claude process above the hook and lists its ancestors", () => {
    expect(findClaudeProcess(400, LINUX_TREE)).toEqual({ pid: 300, tty: "/dev/pts/4", ancestors: [200, 100] });
  });

  it("falls back to the first ancestor with a terminal when no process is named claude", () => {
    const tree = table([
      { pid: 400, ppid: 350, comm: "sh", tty: null },
      { pid: 350, ppid: 200, comm: "node", tty: "/dev/pts/9" },
      { pid: 200, ppid: 1, comm: "bash", tty: "/dev/pts/9" },
    ]);
    expect(findClaudeProcess(400, tree)).toEqual({ pid: 350, tty: "/dev/pts/9", ancestors: [200] });
  });

  it("returns null when the tree cannot be read", () => {
    expect(findClaudeProcess(400, () => null)).toBeNull();
  });
});

describe("collectTerminal", () => {
  const base = { platform: "linux" as const, parentPid: 400, readProc: LINUX_TREE, cwd: "/home/ada/proj" };

  it("captures tmux inside WezTerm on X11", () => {
    const info = collectTerminal({
      ...base,
      env: { TERM_PROGRAM: "tmux", TMUX: "/tmp/tmux-1000/default,4242,0", TMUX_PANE: "%3", WEZTERM_PANE: "12", DISPLAY: ":0", WINDOWID: "41943047" },
    });
    expect(info).toEqual({
      termProgram: "tmux",
      tmux: { socket: "/tmp/tmux-1000/default", pane: "%3" },
      wezterm: { pane: "12" },
      windowId: "41943047",
      tty: "/dev/pts/4",
      pid: 300,
      ancestors: [200, 100],
      cwd: "/home/ada/proj",
      display: "x11",
    });
  });

  it("captures kitty with its remote-control socket on Wayland", () => {
    const info = collectTerminal({
      ...base,
      env: { KITTY_WINDOW_ID: "7", KITTY_LISTEN_ON: "unix:/tmp/kitty-1", WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" },
    });
    expect(info.kitty).toEqual({ windowId: "7", listenOn: "unix:/tmp/kitty-1" });
    expect(info.display).toBe("wayland");
  });

  it("captures GNU screen", () => {
    const info = collectTerminal({ ...base, env: { STY: "1234.pts-0.host", WINDOW: "2" } });
    expect(info.screen).toEqual({ sty: "1234.pts-0.host", window: "2" });
  });

  it("captures iTerm2 and Terminal.app on macOS", () => {
    const iterm = collectTerminal({
      ...base,
      platform: "darwin",
      env: { TERM_PROGRAM: "iTerm.app", ITERM_SESSION_ID: "w0t1p2:6E2E1C3A-0D7B-4E5F-9A1B-2C3D4E5F6A7B", TERM_SESSION_ID: "w0t1p2:6E2E1C3A-0D7B-4E5F-9A1B-2C3D4E5F6A7B" },
    });
    expect(iterm.iterm).toEqual({ sessionId: "w0t1p2:6E2E1C3A-0D7B-4E5F-9A1B-2C3D4E5F6A7B" });
    expect(iterm.appleTerminal).toBeUndefined();
    expect(iterm.display).toBe("macos");

    const terminal = collectTerminal({ ...base, platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal", TERM_SESSION_ID: "6E2E1C3A-0D7B-4E5F-9A1B-2C3D4E5F6A7B" } });
    expect(terminal.appleTerminal).toEqual({ sessionId: "6E2E1C3A-0D7B-4E5F-9A1B-2C3D4E5F6A7B" });
  });

  it("captures Alacritty", () => {
    const info = collectTerminal({ ...base, env: { ALACRITTY_SOCKET: "/run/user/1000/Alacritty-wayland-0-55.sock", ALACRITTY_WINDOW_ID: "94371840" } });
    expect(info.alacritty).toEqual({ socket: "/run/user/1000/Alacritty-wayland-0-55.sock", windowId: "94371840" });
  });

  it("bounds values it copies from the environment", () => {
    const info = collectTerminal({ ...base, env: { TERM_PROGRAM: "x".repeat(5000) } });
    expect(info.termProgram!.length).toBeLessThanOrEqual(256);
  });
});

describe("minimizePayload", () => {
  it("drops tool output and transcript paths and trims what it keeps", () => {
    const result = minimizePayload({
      session_id: "abc12345",
      hook_event_name: "PreToolUse",
      transcript_path: "/home/ada/.claude/x.jsonl",
      tool_response: { stdout: "secret" },
      tool_input: { command: "x".repeat(1000), description: "d".repeat(500), content: "file body", path: "/a/b" },
      prompt: "p".repeat(1000),
      last_assistant_message: "m".repeat(1000),
    });
    expect(result).toEqual({
      session_id: "abc12345",
      hook_event_name: "PreToolUse",
      tool_input: { command: "x".repeat(400), file_path: "/a/b", description: "d".repeat(200) },
      prompt: "p".repeat(400),
      last_assistant_message: "m".repeat(600),
    });
  });

  it("removes a non-object tool_input and passes non-objects through untouched", () => {
    expect(minimizePayload({ session_id: "abc12345", tool_input: "raw" })).toEqual({ session_id: "abc12345" });
    expect(minimizePayload("text")).toBe("text");
  });
});
