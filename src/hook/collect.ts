import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { basename } from "node:path";

export interface ProcInfo {
  pid: number;
  ppid: number;
  comm: string;
  tty: string | null;
}

export type ProcReader = (pid: number) => ProcInfo | null;

// Raw, unvalidated terminal description; the receiver validates it (src/core/terminal.ts).
export interface RawTerminal {
  termProgram?: string;
  tmux?: { socket: string; pane: string };
  screen?: { sty: string; window?: string };
  kitty?: { windowId: string; listenOn?: string };
  wezterm?: { pane: string; socket?: string };
  iterm?: { sessionId: string };
  appleTerminal?: { sessionId: string };
  alacritty?: { socket: string; windowId?: string };
  windowId?: string;
  tty?: string;
  pid?: number;
  ancestors?: number[];
  cwd?: string;
  display?: string;
}

export interface CollectInputs {
  platform: string;
  env: Record<string, string | undefined>;
  parentPid: number;
  readProc: ProcReader;
  cwd?: string;
}

const MAX_VALUE_LENGTH = 256;
const MAX_DEPTH = 12;

export function parseProcStat(stat: string): Omit<ProcInfo, "tty"> | null {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const pid = Number(stat.slice(0, open).trim());
  const ppid = Number(stat.slice(close + 2).split(" ")[1]);
  if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return null;
  return { pid, ppid, comm: stat.slice(open + 1, close) };
}

export function parsePsTable(output: string): ProcInfo[] {
  const rows: ProcInfo[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const tty = match[3]!;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      comm: basename(match[4]!),
      tty: tty === "??" || tty === "-" ? null : `/dev/${tty}`,
    });
  }
  return rows;
}

export function linuxProcReader(): ProcReader {
  return (pid) => {
    try {
      const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
      if (!stat) return null;
      let tty: string | null = null;
      try {
        const target = readlinkSync(`/proc/${pid}/fd/0`);
        if (/^\/dev\/(pts\/\d+|tty\w+)$/.test(target)) tty = target;
      } catch {
        // stdin may be closed or unreadable
      }
      return { ...stat, tty };
    } catch {
      return null;
    }
  };
}

export function psProcReader(): ProcReader {
  let rows: Map<number, ProcInfo> | null = null;
  return (pid) => {
    if (!rows) {
      try {
        const output = execFileSync("ps", ["-A", "-o", "pid=,ppid=,tty=,comm="], { encoding: "utf8", timeout: 500, stdio: ["ignore", "pipe", "ignore"] });
        rows = new Map(parsePsTable(output).map((row) => [row.pid, row]));
      } catch {
        rows = new Map();
      }
    }
    return rows.get(pid) ?? null;
  };
}

export function findClaudeProcess(startPid: number, readProc: ProcReader): { pid: number; tty: string | null; ancestors: number[] } | null {
  const chain: ProcInfo[] = [];
  let pid = startPid;
  for (let depth = 0; depth < MAX_DEPTH && pid > 1; depth++) {
    const info = readProc(pid);
    if (!info) break;
    chain.push(info);
    pid = info.ppid;
  }
  const index = chain.findIndex((p) => /claude/i.test(p.comm));
  const chosen = index >= 0 ? index : chain.findIndex((p) => p.tty !== null);
  if (chosen < 0) return null;
  const claude = chain[chosen]!;
  return { pid: claude.pid, tty: claude.tty, ancestors: chain.slice(chosen + 1).map((p) => p.pid).filter((p) => p > 1) };
}

function bounded(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, MAX_VALUE_LENGTH) : undefined;
}

function displayKind(platform: string, env: CollectInputs["env"]): string | undefined {
  if (platform === "darwin") return "macos";
  if (env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY) return "wayland";
  if (env.DISPLAY) return "x11";
  return undefined;
}

function withOptional<T extends object>(required: T, optional: Record<string, string | undefined>): T {
  const extra = Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined));
  return { ...required, ...extra };
}

export function collectTerminal({ platform, env, parentPid, readProc, cwd }: CollectInputs): RawTerminal {
  const read = (name: string) => bounded(env[name]);
  const info: RawTerminal = {};
  const termProgram = read("TERM_PROGRAM");
  if (termProgram) info.termProgram = termProgram;

  const tmuxSocket = read("TMUX")?.split(",")[0];
  const tmuxPane = read("TMUX_PANE");
  if (tmuxSocket && tmuxPane) info.tmux = { socket: tmuxSocket, pane: tmuxPane };

  const sty = read("STY");
  if (sty) info.screen = withOptional({ sty }, { window: read("WINDOW") });

  const kittyWindow = read("KITTY_WINDOW_ID");
  if (kittyWindow) info.kitty = withOptional({ windowId: kittyWindow }, { listenOn: read("KITTY_LISTEN_ON") });

  const weztermPane = read("WEZTERM_PANE");
  if (weztermPane) info.wezterm = withOptional({ pane: weztermPane }, { socket: read("WEZTERM_UNIX_SOCKET") });

  const itermSession = read("ITERM_SESSION_ID");
  if (itermSession) info.iterm = { sessionId: itermSession };
  const appleSession = read("TERM_SESSION_ID");
  if (termProgram === "Apple_Terminal" && appleSession) info.appleTerminal = { sessionId: appleSession };

  const alacrittySocket = read("ALACRITTY_SOCKET");
  if (alacrittySocket) info.alacritty = withOptional({ socket: alacrittySocket }, { windowId: read("ALACRITTY_WINDOW_ID") });

  const windowId = read("WINDOWID");
  if (windowId) info.windowId = windowId;

  const claude = findClaudeProcess(parentPid, readProc);
  if (claude) {
    if (claude.tty) info.tty = claude.tty;
    info.pid = claude.pid;
    if (claude.ancestors.length) info.ancestors = claude.ancestors.slice(0, 12);
  }
  if (cwd) info.cwd = cwd.slice(0, 1024);
  const display = displayKind(platform, env);
  if (display) info.display = display;
  return info;
}
