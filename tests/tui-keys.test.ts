import { describe, expect, it } from "vitest";
import { keyToCommand, type KeyInfo } from "@/cli/tui/keys";
import { initialState } from "@/cli/tui/state";

const NO_KEY: KeyInfo = { upArrow: false, downArrow: false, return: false, escape: false, tab: false, backspace: false, delete: false, ctrl: false, pageUp: false, pageDown: false };
const key = (overrides: Partial<KeyInfo> = {}): KeyInfo => ({ ...NO_KEY, ...overrides });
const base = initialState({ bell: true });

describe("keyToCommand", () => {
  it("maps navigation keys", () => {
    expect(keyToCommand("j", key(), base)).toEqual({ action: { type: "move", delta: 1 } });
    expect(keyToCommand("", key({ downArrow: true }), base)).toEqual({ action: { type: "move", delta: 1 } });
    expect(keyToCommand("k", key(), base)).toEqual({ action: { type: "move", delta: -1 } });
    expect(keyToCommand("", key({ upArrow: true }), base)).toEqual({ action: { type: "move", delta: -1 } });
    expect(keyToCommand("g", key(), base)).toEqual({ action: { type: "move", delta: -Infinity } });
    expect(keyToCommand("G", key(), base)).toEqual({ action: { type: "move", delta: Infinity } });
  });

  it("maps focus, detail, sort, ended, priority, bell, reconnect, help and quit", () => {
    expect(keyToCommand("", key({ return: true }), base)).toEqual({ effect: "focus" });
    expect(keyToCommand("f", key(), base)).toEqual({ effect: "focus" });
    expect(keyToCommand("d", key(), base)).toEqual({ action: { type: "toggle-detail" } });
    expect(keyToCommand("", key({ tab: true }), base)).toEqual({ action: { type: "toggle-detail" } });
    expect(keyToCommand("s", key(), base)).toEqual({ action: { type: "cycle-sort" } });
    expect(keyToCommand("e", key(), base)).toEqual({ action: { type: "toggle-ended" } });
    expect(keyToCommand("3", key(), base)).toEqual({ action: { type: "priority", level: 3 } });
    expect(keyToCommand("b", key(), base)).toEqual({ action: { type: "toggle-bell" } });
    expect(keyToCommand("r", key(), base)).toEqual({ effect: "reconnect" });
    expect(keyToCommand("?", key(), base)).toEqual({ action: { type: "toggle-help" } });
    expect(keyToCommand("/", key(), base)).toEqual({ action: { type: "label-start" } });
    expect(keyToCommand("q", key(), base)).toEqual({ effect: "quit" });
    expect(keyToCommand("c", key({ ctrl: true }), base)).toEqual({ effect: "quit" });
    expect(keyToCommand("", key({ escape: true }), base)).toEqual({ action: { type: "back" } });
    expect(keyToCommand("x", key(), base)).toBeNull();
  });

  it("routes typing to the label query while it is being edited", () => {
    const editing = { ...base, labelDraft: "be" };
    expect(keyToCommand("q", key(), editing)).toEqual({ action: { type: "label-input", text: "q" } });
    expect(keyToCommand("", key({ backspace: true }), editing)).toEqual({ action: { type: "label-backspace" } });
    expect(keyToCommand("", key({ delete: true }), editing)).toEqual({ action: { type: "label-backspace" } });
    expect(keyToCommand("", key({ return: true }), editing)).toEqual({ action: { type: "label-commit" } });
    expect(keyToCommand("", key({ escape: true }), editing)).toEqual({ action: { type: "label-cancel" } });
    expect(keyToCommand("c", key({ ctrl: true }), editing)).toEqual({ effect: "quit" });
  });

  it("only closes the help overlay or quits while help is open", () => {
    const help = { ...base, help: true };
    expect(keyToCommand("j", key(), help)).toEqual({ action: { type: "back" } });
    expect(keyToCommand("q", key(), help)).toEqual({ effect: "quit" });
  });
});
