# Worklog: TUI duplicated rows on small terminals and after resizing

Tracking number: none (the project opted out of Jira/Linear ids).

## Purpose

On smaller terminals the first session row appeared duplicated. `Screen` clamped the body to at least 3 rows, so when the header, banners, filter line, status line and footer wrapped to more than `height - 3` rows, the frame was taller than the terminal (for example 9 lines at 75x8). Ink then clears and redraws the whole frame on every update, which leaves stale rows on screen.

## Second cause: resizing

Reported after the overflow fix: the first session still duplicates when the terminal goes large, then small, then large again. With `incrementalRendering` Ink only rewrites lines that differ from the previous frame by index and moves the cursor up by the previous frame's height. When the terminal is shrunk, the emulator clips or scrolls the old frame, so row N on screen no longer holds previous line N; lines judged "unchanged" are skipped and stale rows (the first session) stay behind. Ink only clears on a width decrease, not on a height change.

## Changes

- `src/cli/commands/tui.ts`: dropped `incrementalRendering: true`. Each changed frame is now erased and rewritten in full, which does not depend on where the old frame ended up after a resize.

- `src/cli/tui/Screen.tsx`: `fitChrome` trims the chrome in priority order (header, footer, banners, status, filter) so the body keeps at least 3 rows and the frame never exceeds `height`. The body is clamped to 1 row only when the terminal has fewer than 4 rows.

## Decisions

- Trimmed chrome loses its trailing wrapped lines instead of shrinking the body below 3 rows, so the list header and the selected row stay visible.
- Frames that exactly fill the terminal keep Ink's existing incremental path; only overflowing frames were changed.

## Test plan

Automated: `tests/tui-render.test.tsx` "Screen on a short terminal" renders several narrow and short sizes and asserts the frame is never taller than the terminal and still shows the header and the key hints. A sweep of widths 20-120 and heights 4-30 produced no overflowing frame.

Manual: with two or more sessions, drag the terminal large, then small, then large again and check no row is repeated; shrink the terminal to roughly 75x8 with at least two sessions and check the first row is not repeated while sessions update.
