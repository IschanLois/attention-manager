import { runAll, type FocusAdapter, type StepOutcome } from "./types.ts";

export const kittyAdapter: FocusAdapter = {
  id: "kitty",
  role: "host",
  applies: (info) => Boolean(info.kitty),
  run(info, ctx) {
    const { windowId, listenOn } = info.kitty!;
    return runAll(ctx, [["kitten", ["@", ...(listenOn ? ["--to", listenOn] : []), "focus-window", "--match", `id:${windowId}`]]]);
  },
  manualCommand: (info) => `kitten @ focus-window --match id:${info.kitty!.windowId}`,
};

export const weztermAdapter: FocusAdapter = {
  id: "wezterm",
  role: "host",
  applies: (info) => Boolean(info.wezterm),
  run: (info, ctx) => runAll(ctx, [["wezterm", ["cli", "activate-pane", "--pane-id", info.wezterm!.pane]]]),
  manualCommand: (info) => `wezterm cli activate-pane --pane-id ${info.wezterm!.pane}`,
};

// The scripts are constant; the session identifier only ever arrives through argv.
const ITERM_SCRIPT = `on run argv
  set targetId to item 1 of argv
  tell application "iTerm2"
    repeat with aWindow in windows
      repeat with aTab in tabs of aWindow
        repeat with aSession in sessions of aTab
          if unique id of aSession is targetId then
            tell aWindow to select
            tell aTab to select
            tell aSession to select
            activate
            return "focused"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not found"
end run`;

const TERMINAL_APP_SCRIPT = `on run argv
  set targetTty to item 1 of argv
  tell application "Terminal"
    repeat with aWindow in windows
      repeat with aTab in tabs of aWindow
        if tty of aTab is targetTty then
          set selected of aTab to true
          set index of aWindow to 1
          activate
          return "focused"
        end if
      end repeat
    end repeat
  end tell
  return "not found"
end run`;

async function runAppleScript(ctx: Parameters<FocusAdapter["run"]>[1], script: string, arg: string, app: string): Promise<StepOutcome> {
  const result = await ctx.exec("osascript", ["-e", script, arg]);
  if (!result.ok) return { ok: false, reason: `${result.message} (macOS may need Automation permission for ${app})` };
  return result.stdout.trim() === "focused" ? { ok: true } : { ok: false, reason: `${app} has no matching session open` };
}

export const itermAdapter: FocusAdapter = {
  id: "iterm",
  role: "host",
  applies: (info, ctx) => ctx.platform === "darwin" && Boolean(info.iterm),
  run: (info, ctx) => runAppleScript(ctx, ITERM_SCRIPT, info.iterm!.sessionId.split(":")[1]!, "iTerm2"),
};

export const appleTerminalAdapter: FocusAdapter = {
  id: "apple-terminal",
  role: "host",
  applies: (info, ctx) => ctx.platform === "darwin" && Boolean(info.tty) && (info.termProgram === "Apple_Terminal" || Boolean(info.appleTerminal)),
  run: (info, ctx) => runAppleScript(ctx, TERMINAL_APP_SCRIPT, info.tty!, "Terminal"),
};
