import type { TerminalInfo } from "../../core/terminal.ts";
import { hyprlandAdapter, swayAdapter, x11Adapter } from "./desktop.ts";
import { screenAdapter, tmuxAdapter } from "./multiplexers.ts";
import { appleTerminalAdapter, itermAdapter, kittyAdapter, weztermAdapter } from "./terminals.ts";
import { isWayland, type FocusAdapter, type FocusContext, type FocusResult } from "./types.ts";

// Most specific first: the multiplexer pane, then the terminal's own remote control,
// then whatever the desktop offers to raise the window.
const ADAPTERS: FocusAdapter[] = [
  tmuxAdapter,
  screenAdapter,
  kittyAdapter,
  weztermAdapter,
  itermAdapter,
  appleTerminalAdapter,
  x11Adapter,
  swayAdapter,
  hyprlandAdapter,
];

export function planFocus(info: TerminalInfo | null, ctx: FocusContext): FocusAdapter[] {
  if (!info) return [];
  return ADAPTERS.filter((adapter) => adapter.applies(info, ctx));
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./%:@+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function fallbackHint(info: TerminalInfo | null, ctx: FocusContext): string {
  if (!info) return "No terminal information for this session yet; it appears after the next hook event from an updated hook (`attention hooks install`).";
  const where = [info.tty, info.pid ? `pid ${info.pid}` : null, info.cwd ? `cwd ${info.cwd}` : null].filter(Boolean).join(" · ");
  const manual = planFocus(info, ctx)
    .map((adapter) => adapter.manualCommand?.(info))
    .find((command): command is string => Boolean(command));
  const parts = [`Switch to it manually${where ? ` (${where})` : ""}.`];
  if (manual) parts.push(`Run: ${manual}`);
  else if (info.cwd) parts.push(`Run: cd ${shellQuote(info.cwd)}`);
  if (ctx.platform === "linux" && isWayland(ctx.env) && !ctx.env.SWAYSOCK && !ctx.env.HYPRLAND_INSTANCE_SIGNATURE) {
    parts.push("Wayland has no generic window-focus API; only tmux, screen, kitty and WezTerm can be focused here.");
  }
  return parts.join(" ");
}

async function raise(info: TerminalInfo | null, ctx: FocusContext): Promise<FocusResult> {
  const steps = planFocus(info, ctx);
  if (steps.length === 0) return { kind: "unsupported", hint: fallbackHint(info, ctx) };
  const via: string[] = [];
  const failures: string[] = [];
  for (const step of steps) {
    const outcome = await step.run(info!, ctx);
    if (outcome.ok) via.push(step.id);
    else failures.push(`${step.id}: ${outcome.reason}`);
  }
  if (via.length > 0) return { kind: "focused", via, notes: failures };
  return { kind: "failed", reason: failures.join("; "), hint: fallbackHint(info, ctx) };
}

// Raising a window cannot pick a tab inside it (VS Code, GNOME Terminal), so the
// session's tty also gets a bell, which marks that tab and sets the window urgency hint.
export async function focusSession(info: TerminalInfo | null, ctx: FocusContext): Promise<FocusResult> {
  const result = await raise(info, ctx);
  if (!info?.tty) return result;
  const rang = await ctx.ringTty(info.tty);
  return rang.ok ? { ...result, highlighted: info.tty } : result;
}
