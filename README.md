# Claude Code Attention Manager

A local-first dashboard that watches several Claude Code terminal sessions at once and tells you which one needs you: a permission prompt, a question, a repeated failure, or a finished turn. Session state is derived deterministically from Claude Code hook events; a small local model (via Ollama) only interprets the ambiguous ones. Nothing leaves your machine.

Documentation: [how it works](docs/how-it-works.md) (concepts and user-level behaviour), [technical implementation](docs/technical-implementation.md) (architecture, contracts, security model, tests), `PRD.md` (requirements), and `docs/worklogs/` (decisions, verified hook payloads, evaluation results).

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
ln -sfn $PWD/bin/ollama ~/.local/bin/ollama        # puts `ollama` on your PATH
OLLAMA_MODELS=$PWD/models ollama serve &
ollama pull qwen3:1.7b
```

The server must be started with `OLLAMA_MODELS` pointing at the user-local models directory every time, otherwise it looks in `~/.ollama/models` and reports the pulled models as missing. The `ollama` CLI itself (`ollama list`, `ollama pull`) talks to the running server and needs no variable.

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
| `CLASSIFY_TIMEOUT_MS` | `15000` | Inference timeout; one retry after a timeout, then the rule-based state stays. |
| `STALE_AFTER_MS` | `600000` | Sessions without events for this long are flagged stale. |
| `EVENT_HISTORY_LIMIT` | `50` | Events kept per session. |
| `DEDUPE_WINDOW_MS` | `5000` | Identical events inside this window are dropped. |
| `RATE_LIMIT_PER_SESSION` / `RATE_LIMIT_GLOBAL` | `120` / `1200` | Events per minute. |
| `MAX_BODY_BYTES` | `262144` | Maximum request body. |
| `RETENTION_DAYS` / `MAX_SESSIONS` | `7` / `1000` | Purge ended sessions after this many days; cap tracked sessions. |
| `ATTENTION_ALLOW_NO_TOKEN` | unset | Set to `1` to run the receiver without an ingest token (not recommended). |
| `CAPTURE_TASK_CONTEXT` | `1` | Set to `0` to stop capturing prompt, command and narration snippets for task severity. |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug`. Payloads are never logged. |

## Task severity: which agents to watch

Beyond "who is blocked", each card shows a **Risk** badge for how consequential the agent's current task is, so you can keep an eye on the agent rewriting a database schema even while it is still working.

- **Context captured per session:** the latest prompt (first 300 characters), the last five tool actions as "Tool: command or path" snippets, and the agent's last message. Tool outputs, file contents and transcripts are never captured.
- **Keyword rules first:** DDL (`DROP`/`ALTER`/`TRUNCATE`, "drop the users table"), `rm -rf`, force pushes, hard resets, `DELETE FROM`, production deploys, Terraform/kubectl mutations are **critical**; migrations, auth/billing/secrets, `sudo`, `curl | sh`, publishing are **high**; dependency changes, branch switches, broad refactors are **medium**; everything else is **low**.
- **Model second:** on each new prompt and each finished turn the local model rates the task from the same context. It can raise the keyword floor but never lower it. The badge shows "Observed" for keyword matches and "AI · nn%" for model verdicts.
- **Escalation:** a permission request for a critical-risk command, or inside a critical-risk task, is shown as attention priority **critical** instead of high.
- **Ranking:** active before ended, then attention priority, then task severity, then fresh before stale, then recency.

Set `CAPTURE_TASK_CONTEXT=0` to disable the capture; severity then stays at "none" and only the attention state is tracked. The hook script trims prompts and assistant messages and keeps only the `command`, `file_path` and `description` of tool inputs before anything leaves the Claude Code process (when `jq` is installed; without it the receiver drops the rest on arrival).

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
rm -rf ~/.local/opt/ollama ~/.local/bin/ollama
```

## Privacy

Stored per event: session id, normalized event type, receive time, a sanitized summary (tool name, first error line, notification message truncated to 100 characters) and a hash for deduplication. Stored per session for task severity (unless `CAPTURE_TASK_CONTEXT=0`): a 160-character prompt snippet, the last five "Tool: command or path" snippets (120 characters each) and a 300-character snippet of the agent's last message. Never stored or displayed: tool outputs, file contents, transcript paths, full working directories (paths are shown relative to the project or as a basename). Secrets-looking strings are redacted before anything is summarised or sent to the model. The model only receives the event type, tool name, and up to 400 sanitized characters of the relevant text.
