import type { ColorName } from "./theme.ts";

export interface Piece {
  text: string;
  color?: ColorName;
}

// `keep` text only breaks when it is wider than a whole line; `gap` text is a break point that is dropped at a line boundary.
export interface Segment extends Piece {
  keep?: boolean;
  gap?: boolean;
}

export type Line = Piece[];

interface Token extends Piece {
  space: boolean;
}

function tokenize(segments: Segment[]): Token[] {
  const tokens: Token[] = [];
  for (const { text, color, keep, gap } of segments) {
    if (gap) {
      tokens.push({ text, color, space: true });
      continue;
    }
    if (keep) {
      const kept = text.trimEnd() || text;
      tokens.push({ text: kept, color, space: false });
      if (kept.length < text.length) tokens.push({ text: text.slice(kept.length), color, space: true });
      continue;
    }
    for (const part of text.split(/(\s+)/)) if (part) tokens.push({ text: part, color, space: /^\s+$/.test(part) });
  }
  return tokens;
}

function append(line: Line, piece: Piece): void {
  const last = line.at(-1);
  if (last && last.color === piece.color) last.text += piece.text;
  else line.push({ text: piece.text, color: piece.color });
}

function lineWidth(line: Line): number {
  return line.reduce((sum, piece) => sum + piece.text.length, 0);
}

export function wrapSegments(segments: Segment[], width: number, options: { indent?: number } = {}): Line[] {
  const indent = Math.max(0, Math.min(options.indent ?? 0, width - 1));
  const lines: Line[] = [[]];
  let pending: Token[] = [];
  let available = Math.max(1, width);
  let content = false;

  const breakLine = () => {
    const line: Line = indent ? [{ text: " ".repeat(indent) }] : [];
    lines.push(line);
    available = Math.max(1, width - indent);
    pending = [];
    content = false;
  };

  for (const token of tokenize(segments)) {
    if (token.space) {
      if (content) pending.push(token);
      continue;
    }
    const line = lines.at(-1)!;
    const used = lineWidth(line) - (lines.length > 1 ? indent : 0);
    const gap = pending.reduce((sum, t) => sum + t.text.length, 0);
    if (content && used + gap + token.text.length > available) breakLine();
    else for (const space of pending) append(line, space);
    pending = [];
    let rest = token.text;
    while (rest) {
      const current = lines.at(-1)!;
      const room = available - (lineWidth(current) - (lines.length > 1 ? indent : 0));
      if (room <= 0) {
        breakLine();
        continue;
      }
      append(current, { text: rest.slice(0, room), color: token.color });
      rest = rest.slice(room);
      content = true;
    }
  }
  return lines;
}

// Picks the rows around the selection that fit in `space` lines, growing above and below in turn.
export function windowRows(heights: number[], selected: number, space: number): { start: number; end: number } {
  if (heights.length === 0) return { start: 0, end: 0 };
  const index = Math.min(Math.max(0, selected), heights.length - 1);
  let start = index;
  let end = index + 1;
  let used = heights[index];
  let below = true;
  while (true) {
    const canBelow = end < heights.length && used + heights[end] <= space;
    const canAbove = start > 0 && used + heights[start - 1] <= space;
    if (!canBelow && !canAbove) break;
    if ((below && canBelow) || !canAbove) used += heights[end++];
    else used += heights[--start];
    below = !below;
  }
  return { start, end };
}
