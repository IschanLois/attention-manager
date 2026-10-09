# Claude Code Attention Manager

A local-first dashboard that watches several Claude Code terminal sessions at once and tells you which one needs you: a permission prompt, a question, a repeated failure, or a finished turn. Session state is derived deterministically from Claude Code hook events; a small local model (via Ollama) only interprets the ambiguous ones. Nothing leaves your machine.

See `PRD.md` for the full requirements and `docs/worklogs/attention-manager.md` for implementation notes, verified hook payloads, and decisions.

## How it works

```
Claude Code session ──hook──▶ scripts/claude-hook.sh ──POST──▶ receiver (127.0.0.1:4318)
                                                              │  validate · normalize · state machine
                                                              │  SQLite · optional Ollama classification
                                                              ▼
                                        Next.js dashboard (127.0.0.1:3000) ◀── SSE ──┘
```

- **Hooks** (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Notification`, `Stop`, `SubagentStop`, `PreCompact`, `SessionEnd`) run a tiny forwarder that posts the payload to the receiver with a 2 second timeout and always exits 0, so a stopped receiver never blocks Claude Code.
- **Receiver** (`src/receiver`) is a plain Node HTTP service: loopback only, Host/Origin checks, shared ingest token, body limit, rate limits, deduplication. It applies the deterministic state machine (`src/core/sessions/state-machine.ts`), persists to SQLite (`node:sqlite`, no native build), and streams changes over Server-Sent Events.
- **Classifier** (`src/core/classifier`) asks Ollama for a schema-constrained JSON verdict only for ambiguous events: unknown notification types, tool failures with error text, and finished turns that look like a question. Output is validated and can never lower a rule-based priority floor, change a status, or run anything.
- **Dashboard** (`src/app`, `src/components`) proxies the receiver so the browser only talks to its own origin. Observed states are labelled "Observed"; model verdicts are labelled "AI" with their confidence; failed or skipped inference shows as "Unclassified".

## Requirements

- Linux, Node.js 24 or newer (uses built-in TypeScript execution and `node:sqlite`), pnpm 11+.
- Claude Code 2.1.x (hook payloads were verified against 2.1.295).
- `curl` (the hook forwarder falls back to Node if it is missing).
- Optional: [Ollama](https://ollama.com) with a small model for contextual classification. Without it everything still works in rule-based mode.

## Setup

```bash
pnpm install
cp env.example .env           # adjust ports/model if needed
pnpm hooks:install            # writes hooks into ~/.claude/settings.json and creates data/ingest-token
```

`pnpm hooks:install` backs up your settings to `~/.claude/settings.json.attention-backup`, appends one command hook per event (existing hooks are kept), and generates a random ingest token stored with mode 0600 in `data/ingest-token` (plus `data/ingest-header`, which the hook passes to curl so the token never appears on a command line). The receiver refuses to start without a token and rejects events that lack it. Restart any running Claude Code sessions afterwards.

To monitor only one project instead of every session, point the installer at that project's settings:

```bash
CLAUDE_SETTINGS_PATH=/path/to/project/.claude/settings.json pnpm hooks:install
```

### Optional: local model

```bash
ollama pull qwen3:1.7b        # default, ~1.4 GB, best accuracy/latency in our evaluation
# lighter alternative (~1 GB, slightly lower accuracy):
ollama pull qwen2.5:1.5b
```

Evaluation on a GTX 1650 (19 fixture cases, `scripts/eval-classifier.ts`):

| Model | needs_attention correct | priority correct | median latency |
| --- | --- | --- | --- |
| qwen3:1.7b | 16/19 | 18/19 | 1.5 s |
| qwen2.5:1.5b | 15/19 | 15/19 | 1.2 s |
| qwen2.5:3b | 15/19 | 15/19 | 1.6 s |
| qwen3:4b-instruct | 17/19 | 14/19 | 6.6 s (does not fit 4 GB VRAM well) |

The model only sees ambiguous events, and the deterministic rules already cover permission prompts, question-like turn ends and repeated failures, so misses on those fixtures do not change the dashboard.

Set `OLLAMA_MODEL` in `.env` to switch models. A user-local Ollama (no root) works too:

```bash
mkdir -p ~/.local/opt/ollama && cd ~/.local/opt/ollama
curl -L -o ollama.tar.zst https://github.com/ollama/ollama/releases/latest/download/ollama-linux-amd64.tar.zst
tar --zstd -xf ollama.tar.zst
OLLAMA_MODELS=$PWD/models ./bin/ollama serve &
OLLAMA_MODELS=$PWD/models ./bin/ollama pull qwen3:1.7b
```

## Run

```bash
pnpm dev                      # receiver + dashboard together
# or separately:
pnpm receiver                 # http://127.0.0.1:4318
pnpm dev:dashboard            # http://127.0.0.1:3000
```

Open http://localhost:3000, then start two or more Claude Code sessions in other terminals. Ask one of them to run a command that needs approval (for example `touch demo.txt` in default permission mode): its card turns to **Needs attention / High** with the tool name within a second. Approve or deny in that terminal and the card returns to **Working**.

## Diagnostics

```bash
pnpm doctor                   # receiver, hooks, token, SQLite, model, last event, last classification error
curl -s http://127.0.0.1:4318/api/health | jq
pnpm hooks:status
```

The dashboard also shows a diagnostics strip and banners for a disconnected receiver, an unreachable or missing model, and SQLite errors.

## Configuration

All settings are environment variables (see `env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `RECEIVER_HOST` / `RECEIVER_PORT` | `127.0.0.1` / `4318` | Receiver bind address. Keep the host on loopback. |
| `RECEIVER_URL` | `http://127.0.0.1:4318` | Where the dashboard proxies to. |
| `PORT` | `3000` | Dashboard port. |
| `DATABASE_PATH` | `./data/attention.db` | SQLite file; `:memory:` for ephemeral. |
| `INGEST_TOKEN_PATH` | `./data/ingest-token` | Shared secret between hook script and receiver. `ATTENTION_INGEST_TOKEN` overrides. |
| `OLLAMA_URL` / `OLLAMA_MODEL` | `http://127.0.0.1:11434` / `qwen3:1.7b` | Local model runtime and model name. |
| `CLASSIFY_TIMEOUT_MS` | `8000` | Inference timeout; on timeout the rule-based state stays. |
| `STALE_AFTER_MS` | `600000` | Sessions without events for this long are flagged stale. |
| `EVENT_HISTORY_LIMIT` | `50` | Events kept per session. |
| `DEDUPE_WINDOW_MS` | `5000` | Identical events inside this window are dropped. |
| `RATE_LIMIT_PER_SESSION` / `RATE_LIMIT_GLOBAL` | `120` / `1200` | Events per minute. |
| `MAX_BODY_BYTES` | `262144` | Maximum request body. |
| `RETENTION_DAYS` / `MAX_SESSIONS` | `7` / `1000` | Purge ended sessions after this many days; cap tracked sessions. |
| `ATTENTION_ALLOW_NO_TOKEN` | unset | Set to `1` to run the receiver without an ingest token (not recommended). |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug`. Payloads are never logged. |

## Session states and priorities

| Status | Set by |
| --- | --- |
| Starting | `SessionStart` |
| Working | prompt submitted, tool started or finished |
| Needs attention | `PermissionRequest`, `Notification` of type `permission_prompt`, `idle_prompt` or `elicitation_dialog` |
| Error | `PostToolUseFailure` (3 failures in 2 minutes escalate to medium) |
| Completed | `Stop` (a finished turn is never treated as a terminated session) |
| Idle | tool interrupted by the user |
| Ended | `SessionEnd` only; sticky until a new `SessionStart` for the same id |

Priorities: permission and dialog prompts are **high**, idle prompts and repeated failures **medium**, single failures and finished turns **low**. The model may raise a priority above these floors or lower a placeholder, never lower a floor. State transitions and their precedence are documented in `docs/worklogs/attention-manager.md`.

## Tests

```bash
pnpm test        # unit + receiver integration tests (no Ollama needed)
pnpm typecheck
pnpm lint
pnpm build
node --no-warnings=ExperimentalWarning scripts/eval-classifier.ts qwen2.5:1.5b qwen2.5:3b   # live model evaluation (needs Ollama)
```

## Troubleshooting

- **No sessions appear.** Run `pnpm doctor`. Hooks must be installed in the settings file Claude Code actually reads, the receiver must be running on the port the hook script targets (`RECEIVER_PORT`), and the session must have been started after the hooks were installed.
- **401 in the receiver log.** The token in `data/ingest-token` changed after the receiver started, or the hook script points at a different checkout. Restart the receiver.
- **Permission prompts don't show up.** `Notification` hooks only fire in interactive sessions; `PermissionRequest` fires in both. If a session inherits `CLAUDE_CODE_*` environment variables from a parent Claude Code session, it may inherit its permission mode and never prompt.
- **Model unavailable banner.** Check `curl http://127.0.0.1:11434/api/tags`. Install the model with `ollama pull <model>`. The dashboard keeps working with rule-based classification.
- **First classification is slow.** Ollama loads the model on first use (about 6 seconds on a GTX 1650; longer on CPU). Later calls take under a second. The receiver warms the model at startup when it is available.
- **Port in use.** Change `RECEIVER_PORT` (and `RECEIVER_URL`) or `PORT`.

## Teardown

```bash
pnpm hooks:uninstall          # removes only this project's hook entries, backs up settings first
rm -rf data/                  # database and ingest token
# optional: remove the user-local Ollama install and its models
rm -rf ~/.local/opt/ollama
```

## Privacy

Stored per event: session id, normalized event type, receive time, a sanitized summary (tool name, first error line, notification message truncated to 100 characters) and a hash for deduplication. Never stored or displayed: prompts, tool inputs and outputs, transcript paths, full working directories (only the basename is kept as a label). Secrets-looking strings are redacted before anything is summarised or sent to the model. The model only receives the event type, tool name, and up to 400 sanitized characters of the relevant text.
