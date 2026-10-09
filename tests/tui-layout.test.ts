import { describe, expect, it } from "vitest";
import { windowRows, wrapSegments, type Segment } from "@/cli/tui/layout";

function text(lines: ReturnType<typeof wrapSegments>): string[] {
  return lines.map((line) => line.map((piece) => piece.text).join(""));
}

describe("wrapSegments", () => {
  it("keeps a line that fits untouched", () => {
    expect(text(wrapSegments([{ text: "hello world" }], 20))).toEqual(["hello world"]);
  });

  it("wraps at word boundaries instead of truncating", () => {
    expect(text(wrapSegments([{ text: "waiting for a permission decision" }], 12))).toEqual(["waiting for", "a permission", "decision"]);
  });

  it("hard-splits a word longer than the line", () => {
    expect(text(wrapSegments([{ text: "abcdefghij" }], 4))).toEqual(["abcd", "efgh", "ij"]);
  });

  it("keeps a unit together and moves it to the next line when it does not fit", () => {
    const segments: Segment[] = [{ text: "3 sessions", keep: true }, { text: " | ", gap: true }, { text: "1 need you", keep: true }];
    expect(text(wrapSegments(segments, 16))).toEqual(["3 sessions", "1 need you"]);
    expect(text(wrapSegments(segments, 30))).toEqual(["3 sessions | 1 need you"]);
  });

  it("keeps a blank unit at the start of a line", () => {
    expect(text(wrapSegments([{ text: " ", keep: true }, { text: " " }, { text: "x", keep: true }], 10))).toEqual(["  x"]);
  });

  it("indents continuation lines", () => {
    expect(text(wrapSegments([{ text: "ab cd ef" }], 6, { indent: 2 }))).toEqual(["ab cd", "  ef"]);
  });

  it("keeps the style of each piece across a break", () => {
    const lines = wrapSegments([{ text: "one", color: "red" }, { text: " two three", color: "gray" }], 8);
    expect(lines[0]).toEqual([{ text: "one", color: "red" }, { text: " two", color: "gray" }]);
    expect(lines[1]).toEqual([{ text: "three", color: "gray" }]);
  });

  it("returns one empty line for empty input", () => {
    expect(text(wrapSegments([], 10))).toEqual([""]);
  });
});

describe("windowRows", () => {
  it("shows every row when they fit", () => {
    expect(windowRows([1, 2, 1], 0, 5)).toEqual({ start: 0, end: 3 });
  });

  it("keeps the selected row visible and fills around it", () => {
    expect(windowRows([1, 1, 1, 1, 1, 1], 5, 3)).toEqual({ start: 3, end: 6 });
    expect(windowRows([1, 1, 1, 1, 1, 1], 2, 3)).toEqual({ start: 1, end: 4 });
  });

  it("counts wrapped rows by their height", () => {
    expect(windowRows([2, 2, 2, 2], 3, 4)).toEqual({ start: 2, end: 4 });
  });

  it("shows the selected row alone when it is taller than the space", () => {
    expect(windowRows([1, 5, 1], 1, 3)).toEqual({ start: 1, end: 2 });
  });
});
