import { BIN_NAME, VERSION } from "./meta.ts";

const b = BIN_NAME;

const TOPICS: Record<string, string> = {
  tui: `${b} [--keep-running] [--no-bell] [--no-color]
  Open the live terminal UI. Starts the receiver if none is running (and stops it again
  after the last UI quits unless --keep-running). Runs setup first when no config exists.`,
  setup: `${b} setup [--yes]
  Interactive first-run configuration: Claude Code hooks, local AI, terminal integration.
  --yes accepts the defaults without prompting (CI, scripts).`,
  doctor: `${b} doctor [--json]
  Check the receiver, database, local model, hooks, token and terminal focus support.`,
  hooks: `${b} hooks install|uninstall|status
  Add or remove the Claude Code hooks in ~/.claude/settings.json (a backup is kept), or show
  whether they are installed and current.`,
  receiver: `${b} receiver [--port <n>]
  Run the receiver in the foreground (headless use or debugging).`,
  list: `${b} list [--json] [--status s1,s2] [--min-priority p] [--min-risk p] [--sort attention|recent|label] [--all]
  Print a snapshot of sessions. Statuses: needs_attention, error, working, starting, completed,
  idle, ended. Priorities: critical, high, medium, low, none.`,
  focus: `${b} focus <session id or label>
  Jump to the terminal pane or window running that session.`,
};

export function helpText(topic: string | null): string {
  if (topic && TOPICS[topic]) return `Usage: ${TOPICS[topic]}`;
  return `${b} ${VERSION}: see which Claude Code sessions need you, and jump to them.

Usage:
${Object.values(TOPICS)
  .map((text) => "  " + text.split("\n")[0])
  .join("\n")}
  ${b} --version | --help | help <command>

Exit codes: 0 ok, 1 error, 2 misconfiguration or bad usage.
Environment: NO_COLOR, RECEIVER_PORT, OLLAMA_URL, OLLAMA_MODEL, XDG_CONFIG_HOME, XDG_STATE_HOME
(see the README for the full list).`;
}
