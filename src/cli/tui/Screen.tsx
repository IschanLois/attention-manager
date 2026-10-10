import { Box } from "ink";
import type { ReactNode } from "react";
import { isFiltering } from "../model/filters.ts";
import { bannerLines, sessionListHeight, Connecting, Detail, Divider, EmptyState, filterLines, footerLines, headerLines, HelpOverlay, SessionList, statusLines, TextLines } from "./components.tsx";
import type { Line } from "./layout.ts";
import { selectedSession, visibleSessions, type TuiState } from "./state.ts";
import type { Theme } from "./theme.ts";

// Below this body height the detail no longer fits under the list, so it becomes a drill-down.
export const STACK_MIN_ROWS = 14;
const LIST_SHARE = 0.45;
const MIN_BODY_ROWS = 3;

// A frame taller than the terminal makes Ink clear and redraw it on every update, which leaves stale rows on screen.
// The chrome is trimmed in priority order so the body keeps at least MIN_BODY_ROWS and the frame fits the terminal.
function fitChrome(parts: Line[][], height: number): Line[][] {
  let budget = Math.max(0, height - MIN_BODY_ROWS);
  return parts.map((lines) => {
    const kept = lines.slice(0, budget);
    budget -= kept.length;
    return kept;
  });
}

export interface ScreenProps {
  state: TuiState;
  now: number;
  width: number;
  height: number;
  theme: Theme;
  classifierEnabled: boolean;
}

// Pure rendering of the state: no input handling and no I/O, so it can be rendered in tests.
export function Screen({ state, now, width, height, theme, classifierEnabled }: ScreenProps) {
  const sessions = visibleSessions(state, now);
  const selected = selectedSession(state, now);
  // The narrow and wide hints are the same length, so either wraps to the same height.
  const [header, footerRows, banners, status, filter] = fitChrome(
    [
      headerLines(state, now, theme, classifierEnabled, width),
      footerLines(state, theme, false, width),
      bannerLines(state, now, theme, classifierEnabled, width),
      statusLines(state, theme, width),
      filterLines(state, theme, width),
    ],
    height,
  );
  const chrome = header.length + banners.length + filter.length + status.length + footerRows.length;
  const bodyHeight = Math.max(1, height - chrome);
  const stacked = bodyHeight >= STACK_MIN_ROWS;
  const events = selected && state.detail?.sessionId === selected.sessionId ? state.detail.events : null;

  let body: ReactNode;
  if (state.help) body = <HelpOverlay theme={theme} />;
  else if (state.sessions.length === 0 && state.connection === "connecting") body = <Connecting theme={theme} />;
  else if (state.sessions.length === 0 && state.connection !== "connecting") body = <EmptyState filtered={false} theme={theme} />;
  else if (sessions.length === 0 && state.connection !== "connecting") body = <EmptyState filtered={isFiltering(state.filters) || state.labelDraft !== null} theme={theme} />;
  else if (state.view === "detail") body = <Detail session={selected} events={events} now={now} theme={theme} width={width} height={bodyHeight} />;
  else if (stacked) {
    const listHeight = Math.min(sessionListHeight(sessions, state, now, theme, width), Math.max(4, Math.floor(bodyHeight * LIST_SHARE)));
    body = (
      <>
        <SessionList sessions={sessions} state={state} now={now} theme={theme} width={width} height={listHeight} />
        <Divider theme={theme} width={width} />
        <Detail session={selected} events={events} now={now} theme={theme} width={width} height={bodyHeight - listHeight - 1} />
      </>
    );
  } else body = <SessionList sessions={sessions} state={state} now={now} theme={theme} width={width} height={bodyHeight} />;

  return (
    <Box flexDirection="column" width={width}>
      <TextLines lines={header} bold inverse={state.flashUntil > now} />
      <TextLines lines={banners} />
      <TextLines lines={filter} />
      <Box height={bodyHeight} flexDirection="column" overflow="hidden">
        <Box flexDirection="column" flexShrink={0}>
          {body}
        </Box>
      </Box>
      <TextLines lines={status} />
      <TextLines lines={footerLines(state, theme, !stacked, width).slice(0, footerRows.length)} />
    </Box>
  );
}
