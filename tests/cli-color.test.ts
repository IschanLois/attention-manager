import { describe, expect, it } from "vitest";
import { colorEnabled } from "@/cli/context";

describe("colorEnabled", () => {
  it("is on for an interactive terminal by default", () => {
    expect(colorEnabled(true, { TERM: "xterm-256color" }, true)).toBe(true);
  });

  it("respects --no-color, NO_COLOR, TERM=dumb and non-TTY output", () => {
    expect(colorEnabled(false, {}, true)).toBe(false);
    expect(colorEnabled(true, { NO_COLOR: "1" }, true)).toBe(false);
    expect(colorEnabled(true, { NO_COLOR: "" }, true)).toBe(true);
    expect(colorEnabled(true, { TERM: "dumb" }, true)).toBe(false);
    expect(colorEnabled(true, {}, false)).toBe(false);
  });
});
