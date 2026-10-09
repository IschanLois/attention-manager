import type { Priority, SessionStatus } from "../model/types.ts";

export type ColorName = "red" | "redBright" | "yellow" | "yellowBright" | "green" | "cyan" | "blue" | "magenta" | "gray" | "white";

export interface Glyphs {
  selected: string;
  unselected: string;
  status: Record<SessionStatus, string>;
  sep: string;
  live: string;
  offline: string;
  arrow: string;
  ellipsis: string;
}

export interface Theme {
  unicode: boolean;
  colorEnabled: boolean;
  glyphs: Glyphs;
  color(name: ColorName): ColorName | undefined;
  statusColor(status: SessionStatus): ColorName | undefined;
  priorityColor(priority: Priority): ColorName | undefined;
}

const UNICODE: Glyphs = {
  selected: "▶",
  unselected: " ",
  status: { needs_attention: "●", error: "✖", working: "◐", starting: "○", completed: "↩", idle: "◌", ended: "■" },
  sep: "·",
  live: "●",
  offline: "○",
  arrow: "→",
  ellipsis: "…",
};

// Every glyph carries meaning through its text too, so the UI stays readable without colour.
const ASCII: Glyphs = {
  selected: ">",
  unselected: " ",
  status: { needs_attention: "[!]", error: "[x]", working: "[~]", starting: "[ ]", completed: "[<]", idle: "[.]", ended: "[-]" },
  sep: "|",
  live: "*",
  offline: "o",
  arrow: "->",
  ellipsis: "...",
};

const STATUS_COLORS: Record<SessionStatus, ColorName> = {
  needs_attention: "yellowBright",
  error: "redBright",
  working: "cyan",
  starting: "blue",
  completed: "green",
  idle: "gray",
  ended: "gray",
};

const PRIORITY_COLORS: Record<Priority, ColorName> = { critical: "redBright", high: "yellowBright", medium: "yellow", low: "gray", none: "gray" };

export function supportsUnicode(env: Record<string, string | undefined>, platform: string): boolean {
  if (env.TERM === "linux" || env.TERM === "dumb") return false;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  if (!locale) return platform === "darwin";
  return /utf-?8/i.test(locale);
}

export function createTheme({ color, unicode }: { color: boolean; unicode: boolean }): Theme {
  const pick = (name: ColorName) => (color ? name : undefined);
  return {
    unicode,
    colorEnabled: color,
    glyphs: unicode ? UNICODE : ASCII,
    color: pick,
    statusColor: (status) => pick(STATUS_COLORS[status]),
    priorityColor: (priority) => pick(PRIORITY_COLORS[priority]),
  };
}
