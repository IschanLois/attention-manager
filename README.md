# attention: Claude Code Attention Manager

A terminal UI that watches all your Claude Code sessions at once, tells you which one needs you (a permission prompt, a question, a repeated failure, a risky task), and jumps to the terminal, tmux pane or window running it when you press Enter. Session state comes deterministically from Claude Code hook events; a small local model (via Ollama) only interprets the ambiguous ones. Nothing leaves your machine.

```
 attention  ● live · model qwen3:1.7b · 3 sessions · 1 need you · 1 high risk · bell on
 sort attention · ended hidden
     PRIORITY SESSION      STATUS          SEEN   TERMINAL       REASON
 ▶ ● CRITICAL billing-api  Needs attention 0s     tmux %2        ⚠ critical Waiting for permission to run Bash
   ◐ None     docs-site    Working         2m     vscode pts/3   Tool finished
   ✔ Low      infra        Turn complete   5m     kitty 4        Turn finished
 ──────────────────────────────────────────────────────────────────────────────────────────────────
 billing-api (a1b2c3d4) Needs attention CRITICAL
 seen 0s ago · terminal: tmux %2, /dev/pts/4, pid 4242
 …
 j/k move · Enter focus · d expand · / filter · s sort · e ended · 1-5 priority · ? help · q quit
```

Documentation: [how it works](docs/how-it-works.md) (concepts), [technical implementation](docs/technical-implementation.md) (architecture, contracts, security model, tests) and `docs/worklogs/` (decisions and verification history).

## Requirements

- macOS (Intel or Apple Silicon) or Linux (X11 or Wayland). Windows is not supported.
- Node.js 24 or newer (uses the built-in `node:sqlite`; no native modules).
- Claude Code 2.1.x (hook payloads were verified against 2.1.295).
- Optional: [Ollama](https://ollama.com) with a small model for contextual classification. Without it everything still works in rule-based mode.

## Install

```bash
npm i -g attention-manager
attention
```

The first run asks at most three questions and then opens the live UI:

1. **Install the Claude Code hooks** into `~/.claude/settings.json`? Your own hooks are kept, a backup is written to `settings.json.attention-backup` once, and a random ingest token is created (mode 0600). Restart running `claude` sessions afterwards.
2. **Use local AI classification?** The default is `qwen3:1.7b` on `http://127.0.0.1:11434`; you can pick another URL or model, or rule-based only. If the model is missing, setup prints the exact `ollama pull` command; it never downloads anything itself.
3. **Test terminal focus?** Setup shows which focus route it detected for your terminal and tries it.

Re-run `attention setup` at any time to change the answers, or `attention setup --yes` to accept the defaults non-interactively (CI, scripts). Ports, timeouts, retention and limits are never asked; see [Configuration](#configuration).

To watch a single project instead of every session, install the hooks into that project's settings: `CLAUDE_SETTINGS_PATH=/path/to/project/.claude/settings.json attention hooks install`.

## Usage

| Command | What it does |
| --- | --- |
| `attention` | Open the UI. Starts a receiver if none is running and stops it again a few seconds after the last UI quits (`--keep-running` leaves it up). A second `attention` attaches to the same receiver. |
| `attention setup [--yes]` | First-run configuration (re-runnable). |
| `attention doctor [--json]` | Check the receiver, database, model, hooks, token, terminal focus support and which sessions are focusable. |
| `attention hooks install \| uninstall \| status` | Manage the Claude Code hooks. `status` flags hooks left over from an older or moved install as stale. |
| `attention list [--json] [--status s1,s2] [--min-priority p] [--min-risk p] [--sort attention\|recent\|label] [--all]` | Print a snapshot for scripts. `--json` output is versioned (`"version": 1`). |
| `attention focus <session id or label>` | Jump to a session's terminal without opening the UI. |
| `attention receiver [--port n]` | Run the receiver in the foreground (headless use, debugging). |
| `attention --version`, `attention --help`, `attention help <command>` | |

Exit codes: `0` ok, `1` error (for example the receiver is not running), `2` misconfiguration or bad usage (missing hooks, invalid config, unknown flag, ambiguous focus target, port in use).

Global flag: `--no-color` (also `NO_COLOR=1`; colour is off automatically when output is not a terminal or `TERM=dumb`). Without a UTF-8 locale, or on the Linux console, the UI uses ASCII glyphs.

### Key bindings

| Key | Action |
| --- | --- |
| `j` / `k`, arrows, `g` / `G`, PgUp / PgDn | Move the selection |
| `Enter` or `f` | Focus the terminal running the selected session and ring its bell so the right tab is marked |
| `d` or `Tab` | Full-screen detail view (the detail also sits below the list when the terminal is tall enough) |
| `/` | Filter by label or id (Enter keeps it, Esc restores the previous one) |
| `s` | Cycle sort: attention, recent, label |
| `e` | Show or hide ended sessions |
| `1` `2` `3` `4` | Only critical / high and above / medium and above / low and above (press again to clear) |
| `5` | Clear the priority filter |
| `b` | Toggle the terminal bell on new alerts |
| `r` | Reconnect to the receiver now |
| `?` | Help |
| `q`, `Ctrl-C` | Quit (the terminal is always restored, also on crashes and `SIGTERM`) |

When a session newly needs you, errors, or starts critical-risk work, its row is moved up and bolded, the header flashes, the status line says why and the bell rings. Banners appear when the receiver is unreachable (with a retry countdown) or the local model is unavailable (rule-based only); both recover on their own.

### Supported terminals

The hook records where each session runs (terminal, multiplexer, tty, process). Enter then uses the most specific route available, for example the tmux pane first and then the window around it.

| Terminal / environment | macOS | Linux X11 | Linux Wayland | Needs |
| --- | --- | --- | --- | --- |
| tmux | yes | yes | yes | `tmux` on PATH |
| GNU screen | yes | yes | yes | `screen` on PATH |
| kitty | yes | yes | yes | `allow_remote_control yes` (and `listen_on` for focus from outside kitty) |
| WezTerm | yes | yes | yes | `wezterm` CLI |
| iTerm2 | yes | | | Automation permission (macOS asks once) |
| Terminal.app | yes | | | Automation permission (macOS asks once) |
| Any X11 terminal (GNOME Terminal, Konsole, Alacritty, xterm, …) | | yes | | `xdotool` or `wmctrl` |
| sway, Hyprland | | | yes | `swaymsg` / `hyprctl` |
| GNOME / KDE on Wayland without the above | | | no | Wayland offers no generic window-focus API |

When a session cannot be focused, the status line shows its tty, pid and directory plus a command to copy (for example `tmux select-window -t %3`). `attention doctor` tells you which route works for your current shell.

## Local model

```bash
ollama pull qwen3:1.7b        # default, ~1.4 GB, best accuracy/latency in our evaluation
ollama pull qwen2.5:1.5b      # lighter alternative (~1 GB, slightly lower accuracy)
```

Evaluation on a GTX 1650 (19 fixture cases, `scripts/eval-classifier.ts`):

| Model | needs_attention correct | priority correct | median latency |
| --- | --- | --- | --- |
| qwen3:1.7b | 16/19 | 18/19 | 1.5 s |
| qwen2.5:1.5b | 15/19 | 15/19 | 1.2 s |
| qwen2.5:3b | 15/19 | 15/19 | 1.6 s |
| qwen3:4b-instruct | 17/19 | 14/19 | 6.6 s (does not fit 4 GB VRAM well) |

The model only sees ambiguous events; the deterministic rules already cover permission prompts, question-like turn ends and repeated failures. A user-local Ollama (no root) works too:

```bash
mkdir -p ~/.local/opt/ollama && cd ~/.local/opt/ollama
curl -L -o ollama.tar.zst https://github.com/ollama/ollama/releases/latest/download/ollama-linux-amd64.tar.zst
tar --zstd -xf ollama.tar.zst
ln -sfn $PWD/bin/ollama ~/.local/bin/ollama
OLLAMA_MODELS=$PWD/models ollama serve &
ollama pull qwen3:1.7b
```

Start the server with `OLLAMA_MODELS` pointing at the user-local models directory every time, otherwise it looks in `~/.ollama/models` and reports pulled models as missing.

## Task severity: which agents to watch

Beyond "who is blocked", each session carries a risk level for how consequential its current task is, so you can keep an eye on the agent rewriting a database schema even while it is still working.

- **Context captured per session:** the latest prompt (first 300 characters), the last five tool actions as "Tool: command or path" snippets, and the agent's last message. Tool outputs, file contents and transcripts are never captured.
- **Keyword rules first:** DDL (`DROP`/`ALTER`/`TRUNCATE`), `rm -rf`, force pushes, hard resets, `DELETE FROM`, production deploys, Terraform/kubectl mutations are **critical**; migrations, auth/billing/secrets, `sudo`, `curl | sh`, publishing are **high**; dependency changes, branch switches, broad refactors are **medium**; everything else is **low**.
- **Model second:** on each new prompt and finished turn the local model rates the task. It can raise the keyword floor by at most one level and never lower it. The detail view says "Observed" for keyword matches and "AI confidence nn%" for model verdicts, for both the attention reason and the risk; rows show "AI confidence nn%" in front of a model-written reason.
- **Escalation:** a permission request for a critical-risk command is shown as attention priority **critical**.
- **Ranking:** active before ended, then attention priority, then task severity, then fresh before stale, then recency.

Set `CAPTURE_TASK_CONTEXT=0` to disable the capture; severity then stays at "none".

## Session states and priorities

| Status | Set by |
| --- | --- |
| Starting | `SessionStart` |
| Working | prompt submitted, tool started or finished |
| Needs attention | `PermissionRequest`, `Notification` of type `permission_prompt`, `idle_prompt` or `elicitation_dialog` |
| Error | `PostToolUseFailure` (3 failures in 2 minutes escalate to medium) |
| Turn complete | `Stop` (a finished turn is never treated as a terminated session) |
| Idle | tool interrupted by the user |
| Ended | `SessionEnd` only; sticky until a new `SessionStart` for the same id |

Priorities: permission and dialog prompts are **high**, idle prompts and repeated failures **medium**, single failures and finished turns **low**. The model may raise a priority above these floors, never lower one.

## Configuration

Settings that most people never touch have defaults and can be overridden with environment variables (see [`env.example`](env.example)) or the config file.

| Data | Linux | macOS |
| --- | --- | --- |
| Config (`config.json`, `ingest-token`, `ingest-header`) | `$XDG_CONFIG_HOME/attention-manager` (default `~/.config/attention-manager`) | `~/Library/Application Support/attention-manager` |
| Database (`attention.db`) | `$XDG_STATE_HOME/attention-manager` (default `~/.local/state/attention-manager`) | `~/Library/Application Support/attention-manager` |
| Receiver log (`receiver.log`) | `~/.local/state/attention-manager/logs` | `~/Library/Logs/attention-manager` |

Directories are created with mode 0700 and files with 0600. `ATTENTION_CONFIG_DIR` and `ATTENTION_STATE_DIR` override the locations.

`config.json` (written by `attention setup`):

```json
{
  "version": 1,
  "classifier": { "enabled": true, "ollamaUrl": "http://127.0.0.1:11434", "model": "qwen3:1.7b" },
  "terminal": { "confirmed": "tmux+x11" },
  "bell": true,
  "receiver": { "port": 4318 }
}
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `RECEIVER_PORT` / `RECEIVER_HOST` | config `receiver.port` (4318) / `127.0.0.1` | Receiver address. Keep the host on loopback. |
| `ATTENTION_RECEIVER_URL` | from the port | Where the hook and the CLI find the receiver. |
| `OLLAMA_URL` / `OLLAMA_MODEL` | from the config | Local model runtime and model. |
| `CLASSIFY_TIMEOUT_MS` | `15000` | Inference timeout; one retry, then the rule-based state stays. |
| `STALE_AFTER_MS` | `600000` | Sessions without events for this long are marked stale. |
| `EVENT_HISTORY_LIMIT` | `50` | Events kept per session. |
| `DEDUPE_WINDOW_MS` | `5000` | Identical events inside this window are dropped. |
| `RATE_LIMIT_PER_SESSION` / `RATE_LIMIT_GLOBAL` | `120` / `1200` | Events per minute. |
| `MAX_BODY_BYTES` | `262144` | Maximum request body. |
| `RETENTION_DAYS` / `MAX_SESSIONS` | `7` / `1000` | Purge ended sessions after this many days; cap tracked sessions. |
| `CAPTURE_TASK_CONTEXT` | `1` | `0` stops capturing prompt, command and narration snippets. |
| `ATTENTION_HOOK_TIMEOUT` | `2` | Seconds the hook waits for the receiver. |
| `CLAUDE_SETTINGS_PATH` | `~/.claude/settings.json` | Where hooks are installed. |
| `DATABASE_PATH`, `INGEST_TOKEN_PATH` / `ATTENTION_INGEST_TOKEN` | state / config dir | Database file and ingest token overrides. |
| `NO_COLOR` | unset | Disable colour. |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug`. Payloads are never logged. |

## Troubleshooting

- **No sessions appear.** Run `attention doctor`. Hooks must be installed in the settings file Claude Code reads and must not be stale, and the session must have been started after the hooks were installed.
- **`hooks status` says stale after an upgrade or a Node version change.** Run `attention hooks install` again; the hook command records the absolute Node and package paths.
- **Enter does not focus.** `attention doctor` lists the focus route for your current shell and how many sessions are focusable. Sessions started before the hooks were (re)installed carry no terminal information until their next event. On GNOME/KDE Wayland, run Claude inside tmux, kitty or WezTerm. In VS Code, GNOME Terminal and other tabbed terminals the window can be raised but not the tab, so Enter also rings the bell on the session's tty; in VS Code turn on `terminal.integrated.enableBell` (or `accessibility.signals.terminalBell`) to see the bell marker on the tab.
- **Permission prompts don't show up.** `Notification` hooks only fire in interactive sessions; `PermissionRequest` fires in both.
- **Model unavailable banner.** Check `curl http://127.0.0.1:11434/api/tags` and install the model with `ollama pull <model>`. Everything keeps working rule-based.
- **Port in use.** Another program owns 4318; set `RECEIVER_PORT` or `receiver.port` in the config file.
- **Receiver problems.** See the receiver log (paths above) or run `attention receiver` in the foreground.

## Uninstall

```bash
attention hooks uninstall                 # removes only this tool's hook entries
npm rm -g attention-manager
rm -rf ~/.config/attention-manager ~/.local/state/attention-manager          # Linux
rm -rf ~/Library/Application\ Support/attention-manager ~/Library/Logs/attention-manager   # macOS
```

## Development

```bash
pnpm install
pnpm attention            # run the CLI from source (Node 24 type stripping)
pnpm verify               # lint, typecheck, build, tests (incl. the built-binary smoke test), npm pack --dry-run
node scripts/eval-classifier.ts qwen3:1.7b   # live model evaluation (needs Ollama)
```

### Demo

`scripts/demo.sh` opens the TUI and six real Claude Code sessions, each in its own terminal window (or `--tmux` for one tmux session). Three are worded so that no keyword rule matches and the local model (Ollama) decides: one ends its turn asking you to choose without a question mark, one asks to empty a live customer file, and one runs a command that fails harmlessly and should stay low. The others are a file-write approval, an `rm -rf` of the build folder (a keyword rule flags it, the AI explains it) and a one-word answer. Each runs in a folder under `${ATTENTION_DEMO_DIR:-/tmp/attention-demo}` named after its scenario, which becomes its label in the TUI. The script warns if the local model is not available. The sessions use your Claude plan or API credits, nothing is approved for you, and on the first run each window asks you to trust its folder. `scripts/demo.sh --help` lists the options; `scripts/demo.sh --clean` removes the folders.

The package name and binary name live only in `package.json` (`name`, `bin`); everything else, including the data directory names, derives from them.

## Privacy

Stored per event: session id, normalized event type, receive time, a sanitized summary (tool name, first error line, notification message truncated to 100 characters) and a hash for deduplication. Stored per session for task severity (unless `CAPTURE_TASK_CONTEXT=0`): a 160-character prompt snippet, the last five "Tool: command or path" snippets and a 300-character snippet of the agent's last message. Stored per session for terminal focus: the terminal program, multiplexer pane or window ids, tty, the Claude process id and its parent process ids, and the session's working directory. Never stored or displayed: tool outputs, file contents, transcript paths. Secret-looking strings are redacted before anything is summarised or sent to the model. The model only receives the event type, tool name, and up to 400 sanitized characters of the relevant text.
