import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { attentionCount, highRiskCount } from "../model/sort.ts";
import { humaniseEventType, relativeTime, sessionLabel, shortId, sourceLabel } from "../model/format.ts";
import { PRIORITY_LABELS, RISK_LABELS, STATUS_LABELS, type HealthReport, type Priority, type SessionView, type StoredEvent } from "../model/types.ts";
import type { TerminalInfo } from "../../core/terminal.ts";
import type { TuiState } from "./state.ts";
import { windowRows, wrapSegments, type Line, type Segment } from "./layout.ts";
import type { ColorName, Theme } from "./theme.ts";

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

// Renders pre-wrapped lines; each fits the width, so truncation never cuts anything.
export function TextLines({ lines, bold, dimColor, inverse }: { lines: Line[]; bold?: boolean; dimColor?: boolean; inverse?: boolean }) {
  return (
    <>
      {lines.map((line, i) => (
        <Text key={i} bold={bold} dimColor={dimColor} inverse={inverse} wrap="truncate-end">
          {line.length ? line.map((piece, j) => (
            <Text key={j} color={piece.color}>
              {piece.text}
            </Text>
          )) : " "}
        </Text>
      ))}
    </>
  );
}

function joined(items: Segment[], gap: string, color?: ColorName): Segment[] {
  return items.flatMap((item, i) => (i ? [{ text: gap, color, gap: true }, item] : [item]));
}

export function headerLines(state: TuiState, now: number, theme: Theme, classifierEnabled: boolean, width: number): Line[] {
  const { glyphs } = theme;
  const live = state.connection === "live";
  const active = state.sessions.filter((s) => s.status !== "ended").length;
  const model = state.health?.model;
  const modelHealthy = !classifierEnabled || (model?.reachable === true && model.modelInstalled);
  const status: Segment[] = joined(
    [
      { text: `${live ? glyphs.live : glyphs.offline} ${connectionText(state, now)}`, color: theme.color(live ? "green" : "red"), keep: true },
      { text: modelText(state.health, classifierEnabled), color: theme.color(modelHealthy ? "gray" : "yellow"), keep: true },
      { text: `${active} ${active === 1 ? "session" : "sessions"}`, keep: true },
      { text: `${attentionCount(state.sessions)} need you`, color: theme.color("yellowBright"), keep: true },
      { text: `${highRiskCount(state.sessions)} high risk`, color: theme.color("redBright"), keep: true },
      { text: `bell ${state.bell ? "on" : "off"}`, keep: true },
    ],
    ` ${glyphs.sep} `,
  );
  return wrapSegments([{ text: "attention", color: theme.color("magenta"), keep: true }, { text: "  ", gap: true }, ...status], width);
}

export function bannerLines(state: TuiState, now: number, theme: Theme, classifierEnabled: boolean, width: number): Line[] {
  const offline = state.connection === "offline" || state.connection === "reconnecting";
  const model = state.health?.model;
  const degraded = classifierEnabled && model !== undefined && (!model.reachable || !model.modelInstalled);
  const lines: Line[] = [];
  if (offline) {
    const text = `Receiver ${connectionText(state, now)} ${theme.glyphs.sep} sessions shown may be out of date (press r to retry now)`;
    lines.push(...wrapSegments([{ text, color: theme.color("redBright") }], width));
  }
  if (degraded) {
    const cause = model.reachable ? `${model.model} not installed: ollama pull ${model.model}` : "Ollama unreachable";
    lines.push(...wrapSegments([{ text: `Local model unavailable (${cause}) ${theme.glyphs.sep} rule-based only`, color: theme.color("yellow") }], width));
  }
  return lines;
}

export function filterLines(state: TuiState, theme: Theme, width: number): Line[] {
  const { filters } = state;
  const gray = theme.color("gray");
  const parts = [`sort ${filters.sort}`, filters.hideEnded ? "ended hidden" : "ended shown"];
  if (filters.priorities.length) parts.push(`priority ${filters.priorities.at(-1)}+`);
  if (state.labelDraft === null && filters.label) parts.push(`label "${filters.label}"`);
  const draft: Segment[] = state.labelDraft !== null ? [{ text: `/${state.labelDraft}${theme.unicode ? "█" : "_"}`, color: theme.color("cyan") }, { text: "  ", gap: true }] : [];
  return wrapSegments([...draft, ...joined(parts.map((text) => ({ text, color: gray, keep: true })), ` ${theme.glyphs.sep} `, gray)], width);
}

function aiTag(confidence: number | null): string {
  return confidence === null ? "AI" : `AI confidence ${Math.round(confidence * 100)}%`;
}

function riskBadge(session: SessionView, theme: Theme): string {
  if (!RISK_SHOWN.includes(session.taskSeverity)) return "";
  return theme.unicode ? `⚠ ${session.taskSeverity}` : `!${session.taskSeverity}`;
}

const TERMINAL_COLUMN_MIN_WIDTH = 100;
const PRIORITY_WIDTH = 9;
const STATUS_WIDTH = 15;
const SEEN_WIDTH = 7;
const TERMINAL_WIDTH = 14;

const REASON_MIN_WIDTH = 30;

interface RowLayout {
  prefix: number;
  label: number;
  terminal: boolean;
  indent: number;
}

// The label column shrinks to the longest label so the reason gets the rest; a wrapped reason
// continues under the reason column, or under the label when that column would be too narrow.
function rowLayout(width: number, theme: Theme, longestLabel: number): RowLayout {
  const terminal = width >= TERMINAL_COLUMN_MIN_WIDTH;
  const label = Math.max(10, Math.min(longestLabel + 1, 28, Math.floor(width * 0.28)));
  const prefix = theme.glyphs.selected.length + theme.glyphs.status.needs_attention.length + 2;
  const reasonColumn = prefix + PRIORITY_WIDTH + label + 1 + STATUS_WIDTH + 1 + SEEN_WIDTH + (terminal ? TERMINAL_WIDTH + 1 : 0);
  return { prefix, label, terminal, indent: width - reasonColumn >= REASON_MIN_WIDTH ? reasonColumn : prefix };
}

function shortTty(tty: string): string {
  return tty.replace(/^\/dev\//, "");
}

export function terminalShort(terminal: TerminalInfo | null): string {
  if (!terminal) return "?";
  if (terminal.tmux) return `tmux ${terminal.tmux.pane}`;
  if (terminal.screen) return `screen ${terminal.screen.window ?? terminal.screen.sty}`;
  if (terminal.kitty) return `kitty ${terminal.kitty.windowId}`;
  if (terminal.wezterm) return `wezterm ${terminal.wezterm.pane}`;
  if (terminal.iterm) return "iTerm2";
  if (terminal.appleTerminal) return "Terminal.app";
  const parts = [terminal.termProgram, terminal.tty ? shortTty(terminal.tty) : undefined].filter(Boolean);
  return parts.join(" ") || "?";
}

function rowLines(session: SessionView, selected: boolean, now: number, theme: Theme, layout: RowLayout, width: number): Line[] {
  const { glyphs } = theme;
  const label = sessionLabel(session.label, session.sessionId);
  const reason = session.attentionReason ?? humaniseEventType(session.lastEventType);
  const risk = riskBadge(session, theme);
  const ai = session.attentionReason && session.classificationSource === "ai" ? aiTag(session.classificationConfidence) : "";
  const segments: Segment[] = [
    { text: selected ? glyphs.selected : glyphs.unselected, color: theme.color("cyan"), keep: true },
    { text: " " },
    { text: glyphs.status[session.status], color: theme.statusColor(session.status), keep: true },
    { text: " " },
    { text: pad(PRIORITY_LABELS[session.priority], PRIORITY_WIDTH), color: theme.priorityColor(session.priority), keep: true },
    { text: `${pad(label, layout.label)} `, keep: true },
    { text: `${pad(STATUS_LABELS[session.status], STATUS_WIDTH)} `, color: theme.statusColor(session.status), keep: true },
    { text: pad(relativeTime(session.lastSeenAt, now), SEEN_WIDTH), keep: true },
  ];
  if (layout.terminal) segments.push({ text: `${pad(terminalShort(session.terminal), TERMINAL_WIDTH)} `, color: theme.color("blue"), keep: true });
  if (risk) segments.push({ text: `${risk} `, color: theme.priorityColor(session.taskSeverity), keep: true });
  if (ai) segments.push({ text: `${ai} `, color: theme.color("magenta"), keep: true });
  segments.push({ text: reason, color: theme.color("gray") });
  return wrapSegments(segments, width, { indent: layout.indent });
}

function ListHeader({ theme, layout }: { theme: Theme; layout: RowLayout }) {
  const columns = [" ".repeat(layout.prefix), pad("PRIORITY", PRIORITY_WIDTH), pad("SESSION", layout.label), " ", pad("STATUS", STATUS_WIDTH), " ", pad("SEEN", SEEN_WIDTH)];
  if (layout.terminal) columns.push(pad("TERMINAL", TERMINAL_WIDTH), " ");
  columns.push("REASON");
  return (
    <Text color={theme.color("gray")} wrap="truncate-end">
      {columns.join("")}
    </Text>
  );
}

function listRows(sessions: SessionView[], state: TuiState, now: number, theme: Theme, width: number) {
  const layout = rowLayout(width, theme, Math.max(0, ...sessions.map((s) => sessionLabel(s.label, s.sessionId).length)));
  return { layout, rows: sessions.map((session) => rowLines(session, session.sessionId === state.selectedId, now, theme, layout, width)) };
}

// The column header plus every wrapped row.
export function sessionListHeight(sessions: SessionView[], state: TuiState, now: number, theme: Theme, width: number): number {
  return 1 + listRows(sessions, state, now, theme, width).rows.reduce((sum, lines) => sum + lines.length, 0);
}

export function SessionList({ sessions, state, now, theme, width, height }: { sessions: SessionView[]; state: TuiState; now: number; theme: Theme; width: number; height: number }) {
  const selectedIndex = Math.max(0, sessions.findIndex((s) => s.sessionId === state.selectedId));
  const { layout, rows } = listRows(sessions, state, now, theme, width);
  const heights = rows.map((lines) => lines.length);
  const space = Math.max(1, height - 1);
  const overflow = heights.reduce((sum, h) => sum + h, 0) > space;
  const rowSpace = Math.max(1, overflow ? space - 1 : space);
  const { start, end } = windowRows(heights, selectedIndex, rowSpace);
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <ListHeader theme={theme} layout={layout} />
      {sessions.slice(start, end).map((session, i) => {
        const selected = session.sessionId === state.selectedId;
        const highlighted = (state.highlights[session.sessionId] ?? 0) > now;
        const dim = session.status === "ended" || session.stale;
        return <TextLines key={session.sessionId} lines={rows[start + i].slice(0, rowSpace)} bold={selected || highlighted} dimColor={dim && !selected} />;
      })}
      {overflow ? (
        <Text color={theme.color("gray")}>
          {start + 1}-{end} of {sessions.length}
        </Text>
      ) : null}
    </Box>
  );
}

export function Divider({ theme, width }: { theme: Theme; width: number }) {
  return <Text color={theme.color("gray")}>{(theme.unicode ? "─" : "-").repeat(Math.max(0, width))}</Text>;
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

// Wrapped text continues under its first character instead of under the marker.
function Hanging({ marker, markerColor, color, children }: { marker: string; markerColor?: ColorName; color?: ColorName; children: ReactNode }) {
  return (
    <Box>
      <Box flexShrink={0}>
        <Text color={markerColor ?? color}>{marker}</Text>
      </Box>
      <Text wrap="wrap" color={color}>
        {children}
      </Text>
    </Box>
  );
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
      <Box flexDirection="column" flexShrink={0}>
        <Text bold wrap="wrap">
          {sessionLabel(session.label, session.sessionId)} <Text color={theme.color("gray")}>({shortId(session.sessionId)})</Text>{" "}
          <Text color={theme.statusColor(session.status)}>{STATUS_LABELS[session.status]}</Text>{" "}
          <Text color={theme.priorityColor(session.priority)}>{PRIORITY_LABELS[session.priority]}</Text>
          {session.stale ? <Text color={theme.color("gray")}> stale</Text> : null}
        </Text>
        <Text wrap="wrap" color={theme.color("gray")}>
          seen {relativeTime(session.lastSeenAt, now)} ago {theme.glyphs.sep} terminal: {terminalSummary(session.terminal)}
        </Text>
        <Section title="Reason" theme={theme}>
          <Text wrap="wrap">
            {session.attentionReason ?? "Nothing needs you right now."} <Text color={theme.color("gray")}>[{sourceLabel(session.classificationSource, session.classificationConfidence)}]</Text>
          </Text>
          {session.classificationEvidence.slice(0, 3).map((line, i) => (
            <Hanging key={i} marker={`${theme.glyphs.arrow} `} color={theme.color("gray")}>
              {line}
            </Hanging>
          ))}
        </Section>
        <Section title="Task" theme={theme}>
          <Text wrap="wrap">{session.taskSummary ?? "No task captured yet."}</Text>
          <Text wrap="wrap" color={theme.priorityColor(session.taskSeverity)}>
            {RISK_LABELS[session.taskSeverity]}
            {session.taskSeverityReason ? `: ${session.taskSeverityReason}` : ""}
            {session.taskSeverity !== "none" ? <Text color={theme.color("gray")}> [{sourceLabel(session.taskSeveritySource, session.taskSeverityConfidence)}]</Text> : null}
          </Text>
          {riskEvidence.map((line, i) => (
            <Hanging key={i} marker={`${theme.glyphs.arrow} `} color={theme.color("gray")}>
              {line}
            </Hanging>
          ))}
        </Section>
        {session.recentActions.length ? (
          <Section title="Recent actions" theme={theme}>
            {session.recentActions.slice(-5).map((line, i) => (
              <Text key={i} wrap="wrap">
                {line}
              </Text>
            ))}
          </Section>
        ) : null}
        {events && events.length && eventRows > 0 ? (
          <Section title="Recent events" theme={theme}>
            {events.slice(0, eventRows).map((event) => (
              <Hanging key={event.id} marker={pad(relativeTime(event.receivedAt, now), 7)} markerColor={theme.color("gray")}>
                {event.summary ?? humaniseEventType(event.eventType)}
              </Hanging>
            ))}
          </Section>
        ) : null}
      </Box>
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
  ["Enter or f", "focus the session's terminal and ring its bell to mark the tab"],
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
        <Hanging key={keys} marker={pad(keys, 16)} markerColor={theme.color("cyan")}>
          {what}
        </Hanging>
      ))}
      <Text color={theme.color("gray")}>Press any key to close.</Text>
    </Box>
  );
}

export function footerLines(state: TuiState, theme: Theme, narrow: boolean, width: number): Line[] {
  let hints: string[];
  if (state.labelDraft !== null) hints = ["type to filter", "Enter keep", "Esc cancel"];
  else if (state.help) hints = ["any key close", "q quit"];
  else if (state.view === "detail") hints = ["Enter focus", "d/Esc back", "j/k next session", "? help", "q quit"];
  else hints = ["j/k move", "Enter focus", narrow ? "d detail" : "d expand", "/ filter", "s sort", "e ended", "1-5 priority", "? help", "q quit"];
  const gray = theme.color("gray");
  return wrapSegments(joined(hints.map((text) => ({ text, color: gray, keep: true })), ` ${theme.glyphs.sep} `, gray), width);
}

export function statusLines(state: TuiState, theme: Theme, width: number): Line[] {
  if (!state.status) return [[]];
  const tone = state.status.tone;
  const color = tone === "error" ? "redBright" : tone === "warn" ? "yellowBright" : tone === "success" ? "green" : "cyan";
  return wrapSegments([{ text: state.status.text, color: theme.color(color) }], width);
}
