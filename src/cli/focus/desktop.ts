import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isWayland, runAll, type FocusAdapter, type FocusContext, type StepOutcome } from "./types.ts";

const PUSH_TITLE = "\x1b[22;0t";
const POP_TITLE = "\x1b[23;0t";
const TITLE_POLLS = 10;
const TITLE_POLL_MS = 50;

type ReadTitles = (ids: string[]) => Promise<Map<string, string>>;

function toHexWindowId(windowId: string): string {
  if (windowId.startsWith("0x")) return windowId;
  return `0x${Number(windowId).toString(16).padStart(8, "0")}`;
}

async function activateX11Window(ctx: FocusContext, windowId: string): Promise<StepOutcome> {
  const xdotool = await ctx.exec("xdotool", ["windowactivate", windowId]);
  if (xdotool.ok) return { ok: true };
  const wmctrl = await ctx.exec("wmctrl", ["-i", "-a", toHexWindowId(windowId)]);
  return wmctrl.ok ? { ok: true } : { ok: false, reason: `xdotool: ${xdotool.message}; wmctrl: ${wmctrl.message}` };
}

export const x11Adapter: FocusAdapter = {
  id: "x11",
  role: "host",
  applies: (info, ctx) => ctx.platform === "linux" && Boolean(ctx.env.DISPLAY) && !isWayland(ctx.env) && Boolean(info.windowId || info.ancestors?.length),
  async run(info, ctx) {
    if (info.windowId) return activateX11Window(ctx, info.windowId);
    const pids = info.ancestors ?? [];
    for (const pid of pids) {
      const search = await ctx.exec("xdotool", ["search", "--pid", String(pid)]);
      if (!search.ok && search.kind === "missing") return focusViaWmctrlList(ctx, pids, info.tty);
      const windowIds = search.ok ? search.stdout.split(/\s+/).filter((id) => /^\d+$/.test(id)) : [];
      if (windowIds.length > 0) return activateX11Window(ctx, await pickSessionWindow(ctx, windowIds, info.tty, xdotoolTitles(ctx)));
    }
    return { ok: false, reason: "no X11 window found for the terminal process" };
  },
};

async function listWmctrlWindows(ctx: FocusContext): Promise<{ ok: true; windows: Array<{ id: string; pid: number; title: string }> } | { ok: false; message: string }> {
  const list = await ctx.exec("wmctrl", ["-lp"]);
  if (!list.ok) return list;
  const windows = list.stdout
    .split("\n")
    .map((line) => /^(0x[0-9a-fA-F]+)\s+-?\d+\s+(\d+)\s+\S+ (.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ id: m[1]!, pid: Number(m[2]), title: m[3]! }));
  return { ok: true, windows };
}

async function focusViaWmctrlList(ctx: FocusContext, pids: number[], tty: string | undefined): Promise<StepOutcome> {
  const list = await listWmctrlWindows(ctx);
  if (!list.ok) return { ok: false, reason: `install xdotool or wmctrl to focus X11 windows (${list.message})` };
  for (const pid of pids) {
    const windowIds = list.windows.filter((w) => w.pid === pid).map((w) => w.id);
    if (windowIds.length > 0) return runAll(ctx, [["wmctrl", ["-i", "-a", await pickSessionWindow(ctx, windowIds, tty, wmctrlTitles(ctx))]]]);
  }
  return { ok: false, reason: "no X11 window found for the terminal process" };
}

function xdotoolTitles(ctx: FocusContext): ReadTitles {
  return async (ids) => {
    const titles = new Map<string, string>();
    for (const id of ids) {
      const name = await ctx.exec("xdotool", ["getwindowname", id]);
      if (name.ok) titles.set(id, name.stdout.trim());
    }
    return titles;
  };
}

function wmctrlTitles(ctx: FocusContext): ReadTitles {
  return async (ids) => {
    const list = await listWmctrlWindows(ctx);
    return new Map(list.ok ? list.windows.filter((w) => ids.includes(w.id)).map((w) => [w.id, w.title]) : []);
  };
}

// Terminals such as GNOME Terminal serve every window from one process, so the pid alone
// cannot tell the windows apart. The session's tty gets a unique title (the old one is kept
// on the xterm title stack) and the window that shows it is the session's. A tab that is not
// the active one in its window never shows its title, so the first window is the fallback.
async function pickSessionWindow(ctx: FocusContext, windowIds: string[], tty: string | undefined, readTitles: ReadTitles): Promise<string> {
  const first = windowIds[0]!;
  if (windowIds.length < 2 || !tty) return first;
  const probe = `attention-focus-${randomUUID()}`;
  const pushed = await ctx.writeTty(tty, `${PUSH_TITLE}\x1b]2;${probe}\x07`);
  if (!pushed.ok) return first;
  try {
    for (let attempt = 0; attempt < TITLE_POLLS; attempt++) {
      if (attempt > 0) await delay(TITLE_POLL_MS);
      const titles = await readTitles(windowIds);
      const match = windowIds.find((id) => titles.get(id) === probe);
      if (match) return match;
    }
    return first;
  } finally {
    await ctx.writeTty(tty, POP_TITLE);
  }
}

async function focusFirstPid(ctx: FocusContext, pids: number[], command: (pid: number) => [string, string[]]): Promise<StepOutcome> {
  let last: StepOutcome = { ok: false, reason: "no terminal process to focus" };
  for (const pid of pids) {
    last = await runAll(ctx, [command(pid)]);
    if (last.ok) return last;
  }
  return last;
}

export const swayAdapter: FocusAdapter = {
  id: "sway",
  role: "host",
  applies: (info, ctx) => ctx.platform === "linux" && Boolean(ctx.env.SWAYSOCK) && Boolean(info.ancestors?.length),
  run: (info, ctx) => focusFirstPid(ctx, info.ancestors ?? [], (pid) => ["swaymsg", [`[pid=${pid}]`, "focus"]]),
};

export const hyprlandAdapter: FocusAdapter = {
  id: "hyprland",
  role: "host",
  applies: (info, ctx) => ctx.platform === "linux" && Boolean(ctx.env.HYPRLAND_INSTANCE_SIGNATURE) && Boolean(info.ancestors?.length),
  run: (info, ctx) => focusFirstPid(ctx, info.ancestors ?? [], (pid) => ["hyprctl", ["dispatch", "focuswindow", `pid:${pid}`]]),
};
