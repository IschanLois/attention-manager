import { Box } from "ink";
import type { ReactNode } from "react";
import { isFiltering } from "../model/filters.ts";
import { bannerLines, sessionListHeight, Connecting, Detail, Divider, EmptyState, filterLines, footerLines, headerLines, HelpOverlay, SessionList, statusLines, TextLines } from "./components.tsx";
import { selectedSession, visibleSessions, type TuiState } from "./state.ts";
import type { Theme } from "./theme.ts";

// Below this body height the detail no longer fits under the list, so it becomes a drill-down.
export const STACK_MIN_ROWS = 14;
const LIST_SHARE = 0.45;

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
  const header = headerLines(state, now, theme, classifierEnabled, width);
  const banners = bannerLines(state, now, theme, classifierEnabled, width);
  const filter = filterLines(state, theme, width);
  const status = statusLines(state, theme, width);
  // The narrow and wide hints are the same length, so either wraps to the same height.
  const footerHeight = footerLines(state, theme, false, width).length;
  const chrome = header.length + banners.length + filter.length + status.length + footerHeight;
  const bodyHeight = Math.max(3, height - chrome);
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
      <TextLines lines={footerLines(state, theme, !stacked, width)} />
    </Box>
  );
}
