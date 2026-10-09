# Worklog: TUI readability fixes

Tracking number: none (the project opted out of Jira/Linear ids).

## Purpose

Several TUI details were hard to read or redundant: the "just now" age was cut to "just no", AI messages and risk text were dim gray or magenta, and the detail pane repeated what the session list already shows.

## Changes

- `src/cli/tui/components.tsx`:
  - SEEN column widened from 7 to 9 so "just now" fits; Recent events timestamps use the same width.
  - TERMINAL column narrowed from 14 to 12 (fits `Terminal.app`) so the reason keeps its line at 110 columns.
  - AI confidence tag, list reason, `[source]` tags and evidence lines are white.
  - Risk label is white for low/none; the risk explanation is white.
  - Removed the detail title line and the `seen ... | terminal: ...` line, plus the unused `terminalSummary` helper.

## Decisions

- Reasons are white for every session, not only AI-classified ones.
- The short session ID, the `stale` marker and the terminal at widths under 100 columns are no longer shown in the detail pane.

## Test plan

Automated: existing `tests/tui-render.test.tsx` suite passes (the 110-column reason assertion guards the column widths); no new tests, as no logic changed.

Manual: open the TUI with a session seen under 10 s ago and check the SEEN column reads "just now"; check the AI tag, reasons and risk text are legible; confirm the detail pane starts at Reason.
