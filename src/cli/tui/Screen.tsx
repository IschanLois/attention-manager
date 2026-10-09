import { Box } from "ink";
import type { ReactNode } from "react";
import { isFiltering } from "../model/filters.ts";
import { Banners, Detail, EmptyState, FilterBar, Footer, Header, HelpOverlay, SessionList, StatusLine } from "./components.tsx";
import { selectedSession, visibleSessions, type TuiState } from "./state.ts";
import type { Theme } from "./theme.ts";

export const WIDE_MIN_COLUMNS = 100;

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
  const wide = width >= WIDE_MIN_COLUMNS;
  const offline = state.connection === "offline" || state.connection === "reconnecting";
  const degraded = classifierEnabled && state.health !== null && (!state.health.model.reachable || !state.health.model.modelInstalled);
  const chrome = 4 + Number(offline) + Number(degraded);
  const bodyHeight = Math.max(3, height - chrome);
  const events = selected && state.detail?.sessionId === selected.sessionId ? state.detail.events : null;

  let body: ReactNode;
  if (state.help) body = <HelpOverlay theme={theme} />;
  else if (state.sessions.length === 0 && state.connection !== "connecting") body = <EmptyState filtered={false} theme={theme} />;
  else if (sessions.length === 0 && state.connection !== "connecting") body = <EmptyState filtered={isFiltering(state.filters) || state.labelDraft !== null} theme={theme} />;
  else if (state.view === "detail") body = <Detail session={selected} events={events} now={now} theme={theme} width={width} height={bodyHeight} />;
  else if (wide) {
    const listWidth = Math.floor(width * 0.55);
    body = (
      <Box>
        <SessionList sessions={sessions} state={state} now={now} theme={theme} width={listWidth} height={bodyHeight} />
        <Box marginLeft={2} width={width - listWidth - 2}>
          <Detail session={selected} events={events} now={now} theme={theme} width={width - listWidth - 2} height={bodyHeight} />
        </Box>
      </Box>
    );
  } else body = <SessionList sessions={sessions} state={state} now={now} theme={theme} width={width} height={bodyHeight} />;

  return (
    <Box flexDirection="column" width={width}>
      <Header state={state} now={now} theme={theme} classifierEnabled={classifierEnabled} />
      <Banners state={state} now={now} theme={theme} classifierEnabled={classifierEnabled} />
      <FilterBar state={state} theme={theme} />
      <Box height={bodyHeight} flexDirection="column">
        {body}
      </Box>
      <StatusLine state={state} theme={theme} />
      <Footer state={state} theme={theme} narrow={!wide} />
    </Box>
  );
}
