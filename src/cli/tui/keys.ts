import type { Action, TuiState } from "./state.ts";

export interface KeyInfo {
  upArrow: boolean;
  downArrow: boolean;
  return: boolean;
  escape: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  ctrl: boolean;
  pageUp: boolean;
  pageDown: boolean;
}

export type Effect = "focus" | "quit" | "reconnect";
export type Command = { action: Action } | { effect: Effect };

const PAGE = 10;

export function keyToCommand(input: string, key: KeyInfo, state: Pick<TuiState, "labelDraft" | "help">): Command | null {
  if (key.ctrl && input === "c") return { effect: "quit" };

  if (state.labelDraft !== null) {
    if (key.return) return { action: { type: "label-commit" } };
    if (key.escape) return { action: { type: "label-cancel" } };
    if (key.backspace || key.delete) return { action: { type: "label-backspace" } };
    if (input && !key.ctrl) return { action: { type: "label-input", text: input } };
    return null;
  }

  if (state.help) return input === "q" ? { effect: "quit" } : { action: { type: "back" } };

  if (key.downArrow || input === "j") return { action: { type: "move", delta: 1 } };
  if (key.upArrow || input === "k") return { action: { type: "move", delta: -1 } };
  if (key.pageDown) return { action: { type: "move", delta: PAGE } };
  if (key.pageUp) return { action: { type: "move", delta: -PAGE } };
  if (input === "g") return { action: { type: "move", delta: -Infinity } };
  if (input === "G") return { action: { type: "move", delta: Infinity } };
  if (key.return || input === "f") return { effect: "focus" };
  if (key.tab || input === "d") return { action: { type: "toggle-detail" } };
  if (key.escape) return { action: { type: "back" } };

  switch (input) {
    case "/":
      return { action: { type: "label-start" } };
    case "s":
      return { action: { type: "cycle-sort" } };
    case "e":
      return { action: { type: "toggle-ended" } };
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
      return { action: { type: "priority", level: Number(input) as 1 | 2 | 3 | 4 | 5 } };
    case "b":
      return { action: { type: "toggle-bell" } };
    case "r":
      return { effect: "reconnect" };
    case "?":
      return { action: { type: "toggle-help" } };
    case "q":
      return { effect: "quit" };
    default:
      return null;
  }
}
