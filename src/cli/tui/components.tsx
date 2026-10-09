import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { attentionCount, highRiskCount } from "../model/sort.ts";
import { humaniseEventType, relativeTime, sessionLabel, shortId, sourceLabel } from "../model/format.ts";
import { PRIORITY_LABELS, RISK_LABELS, STATUS_LABELS, type HealthReport, type Priority, type SessionView, type StoredEvent } from "../model/types.ts";
import type { TerminalInfo } from "../../core/terminal.ts";
import type { TuiState } from "./state.ts";
import type { Theme } from "./theme.ts";

const RISK_SHOWN: Priority[] = ["critical", "high", "medium"];

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

function connectionText(state: TuiState, now: number): string {
  switch (state.connection) {
    case "live":
      return "live";
    case "connecting":
      return "connecting";
    case "reconnecting":
    case "offline": {
      const seconds = state.retryAt ? Math.max(0, Math.ceil((state.retryAt - now) / 1000)) : 0;
      return `${state.connection}, retry in ${seconds}s`;
    }
  }
}

function modelText(health: HealthReport | null, classifierEnabled: boolean): string {
  if (!classifierEnabled) return "AI off";
  if (!health) return "model ?";
  if (!health.model.reachable) return "model down";
  if (!health.model.modelInstalled) return "model missing";
  return `model ${health.model.model}`;
}

export function Header({ state, now, theme, classifierEnabled }: { state: TuiState; now: number; theme: Theme; classifierEnabled: boolean }) {
  const { glyphs } = theme;
  const live = state.connection === "live";
  const flashing = state.flashUntil > now;
  const active = state.sessions.filter((s) => s.status !== "ended").length;
  const sep = ` ${glyphs.sep} `;
  const model = state.health?.model;
  const modelHealthy = !classifierEnabled || (model?.reachable === true && model.modelInstalled);
  return (
    <Box>
      <Text inverse={flashing} bold wrap="truncate-end">
        <Text color={theme.color("magenta")}>attention</Text>
        {"  "}
        <Text color={theme.color(live ? "green" : "red")}>
          {live ? glyphs.live : glyphs.offline} {connectionText(state, now)}
        </Text>
        {sep}
        <Text color={theme.color(modelHealthy ? "gray" : "yellow")}>{modelText(state.health, classifierEnabled)}</Text>
        {sep}
        {active} {active === 1 ? "session" : "sessions"}
        {sep}
        <Text color={theme.color("yellowBright")}>{attentionCount(state.sessions)} need you</Text>
        {sep}
        <Text color={theme.color("redBright")}>{highRiskCount(state.sessions)} high risk</Text>
        {sep}
        bell {state.bell ? "on" : "off"}
      </Text>
    </Box>
  );
}

export function Banners({ state, now, theme, classifierEnabled }: { state: TuiState; now: number; theme: Theme; classifierEnabled: boolean }) {
  const offline = state.connection === "offline" || state.connection === "reconnecting";
  const model = state.health?.model;
  const degraded = classifierEnabled && model !== undefined && (!model.reachable || !model.modelInstalled);
  return (
    <>
      {offline ? (
        <Text color={theme.color("redBright")} wrap="truncate-end">
          Receiver {connectionText(state, now)} {theme.glyphs.sep} sessions shown may be out of date (press r to retry now)
        </Text>
      ) : null}
      {degraded ? (
        <Text color={theme.color("yellow")} wrap="truncate-end">
          Local model unavailable ({model!.reachable ? `${model!.model} not installed: ollama pull ${model!.model}` : "Ollama unreachable"}) {theme.glyphs.sep} rule-based only
        </Text>
      ) : null}
    </>
  );
}

export function FilterBar({ state, theme }: { state: TuiState; theme: Theme }) {
  const { filters } = state;
  const parts = [`sort ${filters.sort}`, filters.hideEnded ? "ended hidden" : "ended shown"];
  if (filters.priorities.length) parts.push(`priority ${filters.priorities.at(-1)}+`);
  if (state.labelDraft === null && filters.label) parts.push(`label "${filters.label}"`);
  return (
    <Text color={theme.color("gray")} wrap="truncate-end">
      {state.labelDraft !== null ? (
        <Text color={theme.color("cyan")}>
          /{state.labelDraft}
          {theme.unicode ? "█" : "_"}
          {"  "}
        </Text>
      ) : null}
      {parts.join(` ${theme.glyphs.sep} `)}
    </Text>
  );
}

function riskBadge(session: SessionView, theme: Theme): string {
  if (!RISK_SHOWN.includes(session.taskSeverity)) return "";
  return theme.unicode ? `⚠ ${session.taskSeverity}` : `!${session.taskSeverity}`;
}

export function SessionRow({ session, selected, highlighted, now, theme, width }: { session: SessionView; selected: boolean; highlighted: boolean; now: number; theme: Theme; width: number }) {
  const { glyphs } = theme;
  const label = sessionLabel(session.label, session.sessionId);
  const labelWidth = Math.max(10, Math.min(28, Math.floor(width * 0.28)));
  const reason = session.attentionReason ?? session.taskSummary ?? humaniseEventType(session.lastEventType);
  const risk = riskBadge(session, theme);
  const dim = session.status === "ended" || session.stale;
  return (
    <Text wrap="truncate-end" bold={selected || highlighted} inverse={highlighted && !selected} dimColor={dim && !selected}>
      <Text color={theme.color("cyan")}>{selected ? glyphs.selected : glyphs.unselected}</Text>{" "}
      <Text color={theme.statusColor(session.status)}>{glyphs.status[session.status]}</Text>{" "}
      <Text color={theme.priorityColor(session.priority)}>{pad(PRIORITY_LABELS[session.priority], 9)}</Text>
      {pad(label, labelWidth)} <Text color={theme.statusColor(session.status)}>{pad(STATUS_LABELS[session.status], 15)}</Text>{" "}
      {pad(relativeTime(session.lastSeenAt, now), 7)}
      {risk ? <Text color={theme.priorityColor(session.taskSeverity)}>{risk} </Text> : null}
      <Text color={theme.color("gray")}>{reason}</Text>
    </Text>
  );
}

export function SessionList({ sessions, state, now, theme, width, height }: { sessions: SessionView[]; state: TuiState; now: number; theme: Theme; width: number; height: number }) {
  const selectedIndex = Math.max(0, sessions.findIndex((s) => s.sessionId === state.selectedId));
  const rows = Math.max(1, height);
  const start = Math.min(Math.max(0, selectedIndex - Math.floor(rows / 2)), Math.max(0, sessions.length - rows));
  const windowed = sessions.slice(start, start + rows);
  return (
    <Box flexDirection="column" width={width}>
      {windowed.map((session) => (
        <SessionRow
          key={session.sessionId}
          session={session}
          selected={session.sessionId === state.selectedId}
          highlighted={(state.highlights[session.sessionId] ?? 0) > now}
          now={now}
          theme={theme}
          width={width}
        />
      ))}
      {sessions.length > rows ? (
        <Text color={theme.color("gray")}>
          {start + 1}-{Math.min(sessions.length, start + rows)} of {sessions.length}
        </Text>
      ) : null}
    </Box>
  );
}

function terminalSummary(terminal: TerminalInfo | null): string {
  if (!terminal) return "unknown (no hook event with terminal info yet)";
  const parts: string[] = [];
  if (terminal.tmux) parts.push(`tmux ${terminal.tmux.pane}`);
  if (terminal.screen) parts.push(`screen ${terminal.screen.sty}${terminal.screen.window ? `:${terminal.screen.window}` : ""}`);
  if (terminal.kitty) parts.push(`kitty window ${terminal.kitty.windowId}`);
  if (terminal.wezterm) parts.push(`WezTerm pane ${terminal.wezterm.pane}`);
  if (terminal.iterm) parts.push("iTerm2");
  if (terminal.appleTerminal) parts.push("Terminal.app");
  if (!parts.length && terminal.termProgram) parts.push(terminal.termProgram);
  if (terminal.tty) parts.push(terminal.tty);
  if (terminal.pid) parts.push(`pid ${terminal.pid}`);
  return parts.join(", ") || "unknown";
}

function Section({ title, theme, children }: { title: string; theme: Theme; children: ReactNode }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={theme.color("magenta")}>
        {title}
      </Text>
      {children}
    </Box>
  );
}

export function Detail({ session, events, now, theme, width, height }: { session: SessionView | null; events: StoredEvent[] | null; now: number; theme: Theme; width: number; height: number }) {
  if (!session) {
    return (
      <Box width={width}>
        <Text color={theme.color("gray")}>No session selected.</Text>
      </Box>
    );
  }
  const riskEvidence = session.taskSeverityEvidence.slice(0, 3);
  const eventRows = Math.max(0, height - 16);
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Text bold wrap="truncate-end">
        {sessionLabel(session.label, session.sessionId)} <Text color={theme.color("gray")}>({shortId(session.sessionId)})</Text>{" "}
        <Text color={theme.statusColor(session.status)}>{STATUS_LABELS[session.status]}</Text>{" "}
        <Text color={theme.priorityColor(session.priority)}>{PRIORITY_LABELS[session.priority]}</Text>
        {session.stale ? <Text color={theme.color("gray")}> stale</Text> : null}
      </Text>
      <Text wrap="truncate-end" color={theme.color("gray")}>
        seen {relativeTime(session.lastSeenAt, now)} ago {theme.glyphs.sep} terminal: {terminalSummary(session.terminal)}
      </Text>
      <Section title="Reason" theme={theme}>
        <Text wrap="wrap">
          {session.attentionReason ?? "Nothing needs you right now."} <Text color={theme.color("gray")}>[{sourceLabel(session.classificationSource, session.classificationConfidence)}]</Text>
        </Text>
        {session.classificationEvidence.slice(0, 3).map((line, i) => (
          <Text key={i} wrap="truncate-end" color={theme.color("gray")}>
            {theme.glyphs.arrow} {line}
          </Text>
        ))}
      </Section>
      <Section title="Task" theme={theme}>
        <Text wrap="wrap">{session.taskSummary ?? "No task captured yet."}</Text>
        <Text wrap="wrap" color={theme.priorityColor(session.taskSeverity)}>
          {RISK_LABELS[session.taskSeverity]}
          {session.taskSeverityReason ? `: ${session.taskSeverityReason}` : ""}
        </Text>
        {riskEvidence.map((line, i) => (
          <Text key={i} wrap="truncate-end" color={theme.color("gray")}>
            {theme.glyphs.arrow} {line}
          </Text>
        ))}
      </Section>
      {session.recentActions.length ? (
        <Section title="Recent actions" theme={theme}>
          {session.recentActions.slice(-5).map((line, i) => (
            <Text key={i} wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Section>
      ) : null}
      {events && events.length && eventRows > 0 ? (
        <Section title="Recent events" theme={theme}>
          {events.slice(0, eventRows).map((event) => (
            <Text key={event.id} wrap="truncate-end">
              <Text color={theme.color("gray")}>{pad(relativeTime(event.receivedAt, now), 7)}</Text>
              {event.summary ?? humaniseEventType(event.eventType)}
            </Text>
          ))}
        </Section>
      ) : null}
    </Box>
  );
}

export function Connecting({ theme }: { theme: Theme }) {
  return (
    <Box paddingY={1}>
      <Text color={theme.color("gray")}>Connecting to the receiver{theme.glyphs.ellipsis}</Text>
    </Box>
  );
}

export function EmptyState({ filtered, theme }: { filtered: boolean; theme: Theme }) {
  if (filtered) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text>No sessions match the current filters.</Text>
        <Text color={theme.color("gray")}>Press e to show ended sessions, 5 to clear the priority filter, or / to change the label filter.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingY={1}>
      <Text bold>No Claude Code sessions yet.</Text>
      <Text>
        1. Install the hooks: <Text color={theme.color("cyan")}>attention hooks install</Text>
      </Text>
      <Text>2. Start (or restart) `claude` in any terminal. Sessions appear here as soon as they emit an event.</Text>
      <Text color={theme.color("gray")}>Run `attention doctor` if nothing shows up.</Text>
    </Box>
  );
}

const HELP: Array<[string, string]> = [
  ["j / k, arrows", "move the selection (g / G: first / last)"],
  ["Enter or f", "focus the terminal running the selected session"],
  ["d or Tab", "show or hide the detail view"],
  ["/", "filter by label (Enter keeps it, Esc restores)"],
  ["s", "cycle sort: attention, recent, label"],
  ["e", "show or hide ended sessions"],
  ["1-4", "show priority critical / high+ / medium+ / low+ (again to clear)"],
  ["5", "clear the priority filter"],
  ["b", "toggle the terminal bell on new alerts"],
  ["r", "reconnect to the receiver now"],
  ["?", "toggle this help"],
  ["q or Ctrl-C", "quit"],
];

export function HelpOverlay({ theme }: { theme: Theme }) {
  return (
    <Box flexDirection="column" paddingY={1}>
      <Text bold color={theme.color("magenta")}>
        Keyboard
      </Text>
      {HELP.map(([keys, what]) => (
        <Text key={keys}>
          <Text color={theme.color("cyan")}>{pad(keys, 16)}</Text>
          {what}
        </Text>
      ))}
      <Text color={theme.color("gray")}>Press any key to close.</Text>
    </Box>
  );
}

export function Footer({ state, theme, narrow }: { state: TuiState; theme: Theme; narrow: boolean }) {
  const sep = ` ${theme.glyphs.sep} `;
  let hints: string[];
  if (state.labelDraft !== null) hints = ["type to filter", "Enter keep", "Esc cancel"];
  else if (state.help) hints = ["any key close", "q quit"];
  else if (state.view === "detail") hints = ["Enter focus", "d/Esc back", "j/k next session", "? help", "q quit"];
  else hints = ["j/k move", "Enter focus", narrow ? "d detail" : "d expand", "/ filter", "s sort", "e ended", "1-5 priority", "? help", "q quit"];
  return (
    <Text color={theme.color("gray")} wrap="truncate-end">
      {hints.join(sep)}
    </Text>
  );
}

export function StatusLine({ state, theme }: { state: TuiState; theme: Theme }) {
  if (!state.status) return <Text> </Text>;
  const tone = state.status.tone;
  const color = tone === "error" ? "redBright" : tone === "warn" ? "yellowBright" : tone === "success" ? "green" : "cyan";
  return (
    <Text color={theme.color(color)} wrap="truncate-end">
      {state.status.text}
    </Text>
  );
}
