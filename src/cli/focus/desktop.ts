import { isWayland, runAll, type FocusAdapter, type FocusContext, type StepOutcome } from "./types.ts";

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
      if (!search.ok && search.kind === "missing") return focusViaWmctrlList(ctx, pids);
      const windowId = search.ok ? search.stdout.split(/\s+/).find((id) => /^\d+$/.test(id)) : undefined;
      if (windowId) return activateX11Window(ctx, windowId);
    }
    return { ok: false, reason: "no X11 window found for the terminal process" };
  },
};

async function focusViaWmctrlList(ctx: FocusContext, pids: number[]): Promise<StepOutcome> {
  const list = await ctx.exec("wmctrl", ["-lp"]);
  if (!list.ok) return { ok: false, reason: `install xdotool or wmctrl to focus X11 windows (${list.message})` };
  const windows = list.stdout
    .split("\n")
    .map((line) => /^(0x[0-9a-fA-F]+)\s+-?\d+\s+(\d+)\s/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ id: m[1]!, pid: Number(m[2]) }));
  for (const pid of pids) {
    const match = windows.find((w) => w.pid === pid);
    if (match) return runAll(ctx, [["wmctrl", ["-i", "-a", match.id]]]);
  }
  return { ok: false, reason: "no X11 window found for the terminal process" };
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
