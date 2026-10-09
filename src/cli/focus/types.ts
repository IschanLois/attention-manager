import type { TerminalInfo } from "../../core/terminal.ts";

export type ExecResult = { ok: true; stdout: string } | { ok: false; kind: "missing" | "timeout" | "exit"; message: string };

// Binaries are always invoked with an argument array and never through a shell.
export type Exec = (file: string, args: string[], options?: { timeoutMs?: number }) => Promise<ExecResult>;

export interface FocusContext {
  platform: string;
  env: Record<string, string | undefined>;
  exec: Exec;
  ringTty(tty: string): Promise<StepOutcome>;
}

export type StepOutcome = { ok: true } | { ok: false; reason: string };

export interface FocusAdapter {
  id: string;
  role: "multiplexer" | "host";
  applies(info: TerminalInfo, ctx: FocusContext): boolean;
  run(info: TerminalInfo, ctx: FocusContext): Promise<StepOutcome>;
  // A copy-pasteable equivalent shown when automatic focus is not possible.
  manualCommand?(info: TerminalInfo): string | null;
}

// `highlighted` is the tty whose bell was rung so its tab or window is marked.
export type FocusResult = (
  | { kind: "focused"; via: string[]; notes: string[] }
  | { kind: "unsupported"; hint: string }
  | { kind: "failed"; reason: string; hint: string }
) & { highlighted?: string };

export async function runAll(ctx: FocusContext, commands: Array<[string, string[]]>): Promise<StepOutcome> {
  for (const [file, args] of commands) {
    const result = await ctx.exec(file, args);
    if (!result.ok) return { ok: false, reason: result.message };
  }
  return { ok: true };
}

export function isWayland(env: FocusContext["env"]): boolean {
  return env.XDG_SESSION_TYPE === "wayland" || Boolean(env.WAYLAND_DISPLAY);
}
