# Technical implementation

Engineering reference for the Claude Code Attention Manager. For the conceptual overview see [how-it-works.md](./how-it-works.md); for setup see the [README](../README.md); for decisions and verification history see the worklogs in `docs/worklogs/`.

## 1. Stack and runtime

| Concern | Choice | Notes |
| --- | --- | --- |
| Language | TypeScript 5.9, strict, `erasableSyntaxOnly` | Runs from source under Node 24 type stripping in the repo; `tsc -p tsconfig.build.json` emits plain JS to `dist/` for the npm package, because type stripping does not run inside `node_modules` |
| Distribution | npm package `attention-manager`, bin `attention` | `files` ships `dist/`, `README.md`, `LICENSE`; `engines.node >=24`; names come from `package.json` only (`src/cli/meta.ts`) |
| Receiver | Plain `node:http` | No framework; one process, loopback only |
| Persistence | `node:sqlite` (`DatabaseSync`) | Built into Node 24; no native build. Its ExperimentalWarning is filtered inside the bin entry |
| Validation | zod 4 | Hook payloads, terminal identity, CLI config, model output |
| UI | Ink 7 (React 19) terminal UI | Replaced the Next.js dashboard; see section 8 |
| Prompts | `@clack/prompts` | First-run setup only |
| Model runtime | Ollama HTTP API | `qwen3:1.7b` default, configurable |
| Tests | Vitest 5, `ink-testing-library` | Unit, receiver integration, render and built-binary smoke tests |
| Package manager | pnpm 11 for development | Users install with `npm i -g` |

Module layout:

```
src/core/            pure domain code (relative .ts imports)
  schemas.ts         zod schemas, enums, Session/NormalizedEvent types, classifier JSON schema
  terminal.ts        terminal identity schema and sanitiser (allow-list patterns)
  events/normalize.ts   hook payload -> NormalizedEvent, sanitization, redaction, task context
  sessions/state-machine.ts  reduceSession, classification policy, floors, sorting
  sessions/risk.ts   keyword risk rules
  sessions/view.ts   SessionView (adds `stale`), snapshot shapes
  classifier/        contract (prompts, output parsing), ollama client, port types
  persistence/store.ts  SQLite store
  logger.ts
src/receiver/        HTTP service: server.ts, pipeline.ts, sse.ts, rate-limit.ts, config.ts
src/hook/            the hook forwarder (main.ts), terminal collection, payload minimisation
src/cli/             the `attention` CLI
  main.ts            bin entry: arg parsing, platform guard, warning filter, dispatch
  args.ts, help.ts, context.ts, meta.ts, paths.ts, platform.ts, config.ts
  hooks.ts           settings.json merge, status (stale/partial/legacy), token files
  lifecycle.ts       receiver probe / attach / spawn
  client.ts, sse.ts  HTTP and SSE client of the receiver API
  doctor.ts, setup.ts   checks and the first-run flow (pure, with injected I/O)
  commands/          list, focus, hooks, receiver, setup, tui
  focus/             TerminalFocuser adapters and planner
  model/             framework-free sort, filters, formatting, announcements, labels
  tui/               reducer (state.ts), key map, theme, Screen/components, App
scripts/             model evaluation
tests/               Vitest suites and fixtures captured from real hooks
```

## 2. Event ingestion

### 2.1 Hook configuration

`attention hooks install` (also run by `attention setup`) merges one command hook per event into the settings file (`~/.claude/settings.json` by default, or `CLAUDE_SETTINGS_PATH`). Each entry is:

```json
{ "hooks": [{ "type": "command", "command": "\"/abs/node\" \"/abs/node_modules/attention-manager/dist/hook/main.js\"", "timeout": 5 }] }
```

The command is computed at install time from `process.execPath` and the installed package location, so it works without `PATH` lookups and survives a global install. Paths containing `"`, `$`, backticks, backslashes or newlines are refused. Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Notification`, `Stop`, `SubagentStop`, `PreCompact`, `SessionEnd`.

Installer guarantees: existing hooks are kept; only groups emptied by removing our own entry are dropped; our entries (the packaged `dist/hook/main.js`, a source checkout's `src/hook/main.ts`, or the legacy `scripts/claude-hook.sh`) are replaced, never duplicated; the first install writes `settings.json.attention-backup` once; writes go to a temp file then `rename`; the ingest token (0600) and a header file (0600, `x-attention-token: <token>`) are generated in the config directory when missing.

`attention hooks status` reports `installed`, `partial`, `absent` or `stale`. Stale means the hooks point to another install (a moved prefix, another Node version, the legacy shell forwarder) or the referenced file no longer exists; re-running `hooks install` after an upgrade fixes it. It exits 2 for anything but `installed`.

### 2.2 Forwarder (`src/hook/main.ts`)

A dependency-free Node entry (no zod, no sqlite) so it starts fast:

- reads stdin (capped at 1 MiB) and minimises it like the old `jq` filter: drops `tool_response` and `transcript_path`; `tool_input` becomes `{command ≤ 400, file_path, description ≤ 200}`; `prompt` ≤ 400; `last_assistant_message` ≤ 600.
- attaches `terminal`, collected from the environment Claude runs in and from the process tree (section 2.3).
- posts to `ATTENTION_RECEIVER_URL` or `http://127.0.0.1:<RECEIVER_PORT | config receiver.port | 4318>/api/events` with `node:http`, 2 s timeout (`ATTENTION_HOOK_TIMEOUT`), the token read from the 0600 token file (or `ATTENTION_INGEST_TOKEN`); the token never appears in argv.
- a hard timer exits after timeout + 0.5 s; every path exits 0 and nothing is printed.

### 2.3 Terminal identity

Hook payloads only carry `session_id` and `cwd`, so the forwarder records where the session runs (`src/hook/collect.ts`):

| Field | Source |
| --- | --- |
| `termProgram` | `TERM_PROGRAM` |
| `tmux {socket, pane}` | `TMUX` (socket path before the first comma), `TMUX_PANE` |
| `screen {sty, window}` | `STY`, `WINDOW` |
| `kitty {windowId, listenOn}` | `KITTY_WINDOW_ID`, `KITTY_LISTEN_ON` |
| `wezterm {pane, socket}` | `WEZTERM_PANE`, `WEZTERM_UNIX_SOCKET` |
| `iterm {sessionId}` | `ITERM_SESSION_ID` |
| `appleTerminal {sessionId}` | `TERM_SESSION_ID` when `TERM_PROGRAM=Apple_Terminal` |
| `alacritty {socket, windowId}` | `ALACRITTY_SOCKET`, `ALACRITTY_WINDOW_ID` |
| `windowId` | `WINDOWID` (X11) |
| `tty`, `pid`, `ancestors` | the Claude process found by walking the parent chain from the hook (`/proc/<pid>/stat` and `/proc/<pid>/fd/0` on Linux, one `ps -A -o pid=,ppid=,tty=,comm=` on macOS): the first ancestor whose command contains `claude`, else the first with a terminal; `ancestors` are the up to 12 processes above it (the terminal emulator is usually among them) |
| `cwd`, `display` | payload `cwd`; `x11` / `wayland` / `macos` from `XDG_SESSION_TYPE`, `WAYLAND_DISPLAY`, `DISPLAY` |

The receiver treats all of it as untrusted: `hookEventSchema.terminal` is `unknown`, and `sanitizeTerminal` (`src/core/terminal.ts`) validates every field independently against a strict allow-list pattern (pane `^%\d+$`, ids digits or UUIDs, paths `^/[A-Za-z0-9_./@+-]+$`, tty `/dev/pts/N` or `/dev/ttyX`, pids as positive integers). Anything else, including shell metacharacters and control characters, is dropped field by field; the event itself is never rejected for it. `reduceSession` keeps the latest terminal, so a resumed session that reappears in another pane updates.

### 2.4 Verified payload facts (Claude Code 2.1.295)

Every event carries `session_id` (UUID), `cwd`, `hook_event_name`, usually `prompt_id`. Specifics used by the normalizer:

| Event | Fields used |
| --- | --- |
| `SessionStart` | `source` (`startup`, `resume`, `clear`, `compact`) |
| `UserPromptSubmit` | `prompt` |
| `PreToolUse`, `PostToolUse` | `tool_name`, `tool_use_id`, `tool_input` |
| `PostToolUseFailure` | `tool_name`, `tool_use_id`, `error`, `is_interrupt` |
| `PermissionRequest` | `tool_name`, `tool_use_id`, `tool_input` (fires in headless and interactive sessions) |
| `Notification` | `message`, `notification_type` (`permission_prompt`, `idle_prompt`, `elicitation_dialog`, `auth_success`, …; interactive sessions only) |
| `Stop` | `last_assistant_message` |
| `SessionEnd` | `reason` |

Hooks carry no timestamps; the receiver stamps `receivedAt` on arrival and processes events in arrival order.

### 2.5 Receiver HTTP surface

| Route | Purpose | Controls |
| --- | --- | --- |
| `POST /api/events` | ingest | token (constant-time compare), `Content-Type: application/json`, body ≤ `MAX_BODY_BYTES` (byte-counted, chunked bodies get 413), global and per-session token buckets, dedupe |
| `GET /api/sessions` | sorted snapshot `{sessions, now, staleAfterMs}` | |
| `GET /api/sessions/:id` | `{session, events, now}` with bounded history | id regex, 400 on bad encoding, 404 unknown |
| `GET /api/health` | diagnostics (`app` name, version, receiver incl. SSE client count, sqlite, model, last event, last classification error, session count) | |
| `GET /api/stream` | SSE: `snapshot`, `health`, `session`, `session_removed`, heartbeat comments | client cap (`maxSseClients`, default 16) |

All routes first require `Host` ∈ {localhost, 127.0.0.1, [::1], bound host} and a loopback `Origin` when present. No CORS headers are ever sent. Responses carry `nosniff` and `no-store`. Server timeouts: headers 5 s, request 10 s.

Responses to ingest: `202 {accepted:true}`, `200 {accepted:false, reason:"unsupported_event"|"duplicate"}`, `400 invalid_payload`, `401`, `403`, `413`, `415`, `429`.

### 2.6 Pipeline (`src/receiver/pipeline.ts`)

```
raw JSON ─▶ normalizeHookEvent ─▶ dedupe check ─▶ reduceSession ─▶ store.upsert + insertEvent
                                                     │
                                                     ├─▶ onSessionChanged → SSE broadcast
                                                     ├─▶ shouldClassify?     → enqueue("attention")
                                                     └─▶ shouldClassifyTask? → enqueue("task")
```

- In-memory `Map<sessionId, Session>` is the source of truth at runtime, loaded from SQLite at start.
- Session cap (`MAX_SESSIONS`, default 1000): when exceeded, ended then oldest sessions are evicted and broadcast as `session_removed`. Purge of ended sessions and events older than `RETENTION_DAYS` runs at start and hourly.
- `CAPTURE_TASK_CONTEXT=0` blanks `taskText`, `taskKind` and `riskHits` before reduction.

## 3. Normalization (`src/core/events/normalize.ts`)

`normalizeHookEvent(raw, receivedAt)` returns `{ok:true,event}` or `{ok:false,reason}`.

- Rejects non-objects, unknown `hook_event_name` (`unsupported_event`), schema failures and bad session ids (`invalid_payload`). `SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/`.
- zod strips unknown keys; `prompt`, `error`, `last_assistant_message` are truncated to 100 000 chars instead of rejected.
- `sanitizeText(text, max)`: strips ANSI, C0 controls, bidi/zero-width/BOM characters, redacts secret-looking tokens (`sk-…`, GitHub tokens, Slack tokens, AWS keys, `password=`, 40+ char alphanumerics) with `[redacted]`, collapses whitespace, truncates.
- `sanitizeIdentifier` is used for tool names, tool ids, notification types, prompt ids and sources: bounded and control-stripped but never redacted, so long MCP tool names survive.
- `summary` (≤160 chars) is a template: "Running Bash", "Bash failed: Exit code 1", "Permission requested for Write", "Notification (idle_prompt): …", never prompt or tool-input text.
- `classifierText` (≤400 chars) is the attention classifier's input: error text, notification message, or last assistant message. Not persisted.
- `taskKind`/`taskText` (≤300 chars): `prompt` → the prompt; `tool_start`/`permission_request` → `"<Tool>: <command | relative path | description>"`; `turn_complete` → last assistant message. `riskHits = assessRisk(taskText)`.
- `dedupeKey` = sha256 of session, type, tool id, notification type, summary, prompt id and a hash of the classifier text; `null` for `subagent_stop` and `compact`. Identical keys inside `DEDUPE_WINDOW_MS` (default 5 s) are dropped.
- `label` = basename of `cwd`.

## 4. State machine (`src/core/sessions/state-machine.ts`)

`reduceSession(previous, event)` is pure. It stamps `lastSeenAt`, `lastEventType`, `eventSeq+1`, then applies the transition. Ended sessions ignore everything except `session_start`.

| Event | Transition |
| --- | --- |
| `session_start` | `starting`/none; `source=compact` is a no-op on a live session; `startedAt` is kept from the first start; failures cleared; task context kept |
| `prompt` | `working`/none; task context reset (`taskSummary`, floor from keywords or `low`, `recentActions=[]`) |
| `tool_start` | `working`/none; action recorded; keyword hits may raise severity; ignored while a different tool's permission is pending |
| `tool_end` | `working`; ignored after `completed` with no pending permission (delayed event) or for a different tool than the pending permission |
| `tool_failure` | `error`/low, or medium when ≥3 failures in 2 min; `is_interrupt` → `idle`/low; ignored (except failure count) for a different tool than the pending permission |
| `permission_request` | `needs_attention`; `critical` when the command's risk is critical or the task severity is critical, else `high`; remembers `pendingPermissionToolUseId` |
| `notification` | `permission_prompt` high (no-op if a permission is already pending), `elicitation_dialog` high, `idle_prompt` medium, `auth_success` no-op, unknown types → `medium` placeholder with source `fallback` unless a rule-based needs-attention is active |
| `turn_complete` | `completed`/low, or medium when the message looks like a question; narration recorded; keyword hits may raise severity |
| `subagent_stop`, `compact` | last-seen only |
| `session_end` | `ended`/none, `endedAt` set |

Attention classification:

- `shouldClassify` → unknown notifications, non-interrupt failures with text, question-like turn ends.
- `applyClassification(session, trigger, result, at, triggerSeq)`: ignored for ended sessions or when `eventSeq` moved on; `needs_attention=false` → none; `critical` only when status is `error` or `needs_attention`; final priority = max(model, `priorityFloor(trigger)`) where floors are permission high (critical for critical-risk commands), dialog high, idle medium, failure low, turn end low.
- `recordClassificationFailure` sets source `fallback` and the error text (≤200 chars).

Task severity:

- `shouldClassifyTask` → `prompt` and `turn_complete` with task text.
- `applyTaskClassification`: severity = clamp(max(model, floor), ≤ floor + one level); source `ai`, reason, evidence, confidence, `taskClassifiedAt`.
- Keyword raises (`raiseTaskRisk`) only move the floor upward until the next prompt resets it.

Helpers: `isStale(session, now, threshold)` (never for ended), `sortSessions` (ended last → priority → task severity → stale last → recency → id), `looksLikeQuestion`.

## 5. Risk rules (`src/core/sessions/risk.ts`)

Ordered regex table; the highest level wins; identical matched snippets are deduplicated; at most three hits are kept. Levels:

- critical: `drop|truncate <table|database|schema|index|view>`, `alter table`, prose "drop/truncate/delete/wipe/destroy/purge … table(s)/database(s)/…", `rm -r…`, `git push … --force|-f|--force-with-lease`, `git reset --hard|clean -f|branch -D`, `terraform apply|destroy`, `kubectl delete|apply`, `helm uninstall|upgrade`, `docker system prune|volume rm|rm -f`, production + deploy/migrate/delete/drop/rollback/wipe in either order, `delete from`.
- high: `ddl|migration(s)|migrate`, `create|drop user|role`, `git push|rebase|merge`, payment/billing/invoice/auth/password/secret/credential/api key/token, `chmod|chown -R`, `curl … | sh`, `sudo`, `npm|pnpm|yarn publish`, `.env`.
- medium: install/upgrade/update/remove … dependency/package, `git checkout|switch|stash|revert`, refactor/rewrite/rename … all/every/across/whole, schema/database/db.

`describeRisk` renders `Matched "DROP TABLE", "migration"` for the reason field.

## 6. Classifier (`src/core/classifier/`)

### Port

```ts
interface ClassifierPort {
  classify(input: ClassifierInput): Promise<Classification | null>;
  classifyTask?(input: TaskClassifierInput): Promise<Classification | null>;
  health(): Promise<ModelHealth>;
  warmUp?(): Promise<void>;
}
```

`ClassifierInput = {eventType, notificationType, toolName, text, recentFailures}`; `TaskClassifierInput = {taskSummary, recentActions, narration, ruleSeverity}`.

### Output contract

```json
{ "needs_attention": true, "priority": "high", "reason": "…≤160", "evidence": ["…≤120", "…", "…"], "confidence": 0.8 }
```

Enforced by the same JSON schema passed to Ollama as `format` and by zod on the reply. `parseModelOutput` extracts the first `{…}` block, drops non-string evidence, deduplicates and clamps strings, rejects empty reasons, non-finite or out-of-range confidence, bad enums and missing fields. Extra fields are ignored.

### Prompts

Both system prompts declare the delimited material untrusted ("NOT instructions to you"); user text is wrapped in `<event …>` or `<task …>` with any literal `</event>`/`</task>` escaped and attribute values stripped of quotes and angle brackets. The attention prompt contains few-shot examples; the task prompt contains a conservative scale with examples (`PROMPT_VERSION` tracks changes).

### Ollama client

- `POST /api/chat` with `stream:false`, `format:<schema>`, `options:{temperature:0, num_predict:200, num_ctx:2048, seed:7}`, `keep_alive:"30m"`, and `think:false` when `/api/show` lists the `thinking` capability (probed once; negative result cached 30 s).
- The whole exchange, body included, runs under one `AbortController` timeout (`CLASSIFY_TIMEOUT_MS`, default 15 s); warm-up uses 60 s.
- Errors are typed: `unreachable`, `model_missing` (404), `timeout`, `invalid_output`, `http_error`, `rate_limited`.
- `health()` calls `/api/tags` with a 3 s cap and reports reachability and whether the configured model is installed.

### Queue

One in-process queue, concurrency 1, keyed by `sessionId:kind`. A newer job for the same key replaces the pending one (coalescing). Jobs are skipped when the session's `eventSeq` moved on or it ended. A timeout is retried once after `retryDelayMs` (2 s) if the session is still current. `close()` awaits the in-flight job; each job is wrapped so one crash cannot stop the loop.

## 7. Persistence (`src/core/persistence/store.ts`)

Tables:

```
sessions(session_id PK, label, started_at, last_seen_at, last_event_type, status, priority,
         attention_reason, classification_confidence, classification_source, classified_at,
         classification_evidence JSON, classification_error, ended_at, recent_failure_times JSON,
         pending_permission_tool_use_id, event_seq,
         task_summary, recent_actions JSON, last_narration, task_rule_severity, task_severity,
         task_severity_source, task_severity_reason, task_severity_evidence JSON,
         task_severity_confidence, task_classified_at, terminal JSON)
session_events(id PK, session_id, event_type, received_at, summary, dedupe_key)
```

Indexes on `last_seen_at`, `(session_id, id DESC)`, `(dedupe_key, received_at)`. WAL mode. New columns are added with idempotent `ALTER TABLE` migrations. Per-session history is pruned to `EVENT_HISTORY_LIMIT` on every insert. `purge(now, maxAge)` deletes ended sessions and old or orphaned events. The database file is chmod 0600 and its directory is created on demand; if the file cannot be opened the receiver falls back to `:memory:` and reports it in health.

## 8. Terminal UI and CLI

### Commands

| Command | Purpose | Exit codes |
| --- | --- | --- |
| `attention` | TUI; runs setup first when no config exists; ensures a receiver | 0, 2 without a TTY or on a port conflict |
| `attention setup [--yes]` | first-run configuration (see Setup below) | 0, 1 cancelled or failed |
| `attention doctor [--json]` | checks (config, token, hooks, receiver, database, model, ingestion, terminal focus, focusable sessions) | 0 ok, 1 broken, 2 misconfigured |
| `attention hooks install\|uninstall\|status` | section 2.1 | status: 0 installed, 2 otherwise |
| `attention receiver [--port]` | foreground receiver | 2 on `EADDRINUSE`/`EACCES` |
| `attention list [--json] [--status] [--min-priority] [--min-risk] [--sort] [--all]` | snapshot in attention order; unknown values exit 2 | 1 when the receiver is down |
| `attention focus <id\|label>` | exact id, exact label, then unique prefix | 0 focused, 1 not found/unfocusable, 2 ambiguous |

`list --json` is versioned: `{version: 1, generatedAt, sessions: [{id, label, status, priority, reason, taskSeverity, taskSeverityReason, taskSummary, lastSeenAt, startedAt, endedAt, stale, focusable, terminal}]}`. Fields are only ever added.

### Receiver lifecycle (`src/cli/lifecycle.ts`)

`attention` probes `GET /api/health`. A response with `app: "attention-manager"` (or the receiver's health shape) is attached to; a refused connection spawns `node dist/cli/main.js receiver --exit-when-idle` detached, with stdout/stderr appended to the receiver log, and polls health for up to 6 s; any other answer on the port is a conflict (exit 2 with the port and how to change it). The spawned receiver exits 3 s after its last SSE client disconnects (20 s grace at startup), so quitting or crashing the last UI never leaves an orphan, a second UI simply attaches, and a receiver started by someone else is never stopped. `--keep-running` spawns without `--exit-when-idle`.

### Terminal focus (`src/cli/focus/`)

`planFocus(terminal, {platform, env, exec})` returns the adapters that apply, most specific first; `focusSession` runs them all and returns `focused` (any step succeeded, failures noted), `failed` (reasons plus a manual hint) or `unsupported` (hint only).

| Adapter | Applies when | Command (argv, never a shell) |
| --- | --- | --- |
| tmux | `terminal.tmux` | `tmux -S <socket> select-window -t %N`, `select-pane -t %N`, plus `switch-client -t %N` when the UI runs on the same tmux server |
| screen | `terminal.screen` with a window | `screen -S <sty> -X select <window>` |
| kitty | `terminal.kitty` | `kitten @ [--to <listenOn>] focus-window --match id:N` (needs `allow_remote_control`) |
| wezterm | `terminal.wezterm` | `wezterm cli activate-pane --pane-id N` |
| iterm | macOS and `terminal.iterm` | `osascript -e <constant script> <uuid>`, matched on the session's `unique id` |
| apple-terminal | macOS, Terminal.app and a tty | `osascript -e <constant script> <tty>`, matched on the tab's `tty` |
| x11 | Linux, `DISPLAY` set, not Wayland | `xdotool windowactivate <WINDOWID>`, falling back to `wmctrl -i -a 0x…`; without `WINDOWID`, `xdotool search --pid` or `wmctrl -lp` over the ancestors |
| sway / hyprland | `SWAYSOCK` / `HYPRLAND_INSTANCE_SIGNATURE` | `swaymsg [pid=N] focus` / `hyprctl dispatch focuswindow pid:N` over the ancestors |

AppleScript identifiers are passed through `on run argv`, never interpolated. Every call goes through `execFile` with a 1.5 s timeout; a missing binary, a timeout and a non-zero exit become distinct failure reasons. Generic Wayland (GNOME, KDE) has no focus API, which `doctor`, `setup` and the fallback hint say explicitly.

### TUI (`src/cli/tui/`)

- `state.ts` is a pure reducer: snapshot/session/removed/health/connection events, selection anchored to a session id (clamped by index when it disappears), filters (status, priority shortcuts, ended, label query with live preview and cancel), sort cycle, view (stacked or drill-down), help, bell, status line, highlights and header flash. Cues come from `announcementFor` (newly needs attention or error, newly critical risk) and never fire for a reconnect snapshot.
- `keys.ts` maps input to actions or effects (`focus`, `quit`, `reconnect`); while the label query is open every key goes to it.
- `Screen.tsx` renders the state with no I/O: header (connection, model, counts, bell), banners (receiver offline with retry countdown, model degraded), filter bar, full-width list (column header, terminal column at 100+ columns, no task summary; that stays in the detail) with the detail stacked below it when the body has 14+ rows, list/detail drill-down below that, status line, context-sensitive footer, help overlay, empty and connecting states. The list scrolls around the selection.
- `App.tsx` owns the effects: SSE via `src/cli/sse.ts` (backoff 0.5 s doubling to 15 s with ±20% jitter, `offline` after three failures, 40 s idle timeout against dead sockets), health polling every 10 s, a 1 s tick, debounced detail fetches from `/api/sessions/:id`, the bell, and focus.
- `theme.ts`: colour off for `NO_COLOR`, `TERM=dumb`, non-TTY output or `--no-color`; Unicode glyphs only with a UTF-8 locale and `TERM≠linux`. Every glyph has a textual meaning, so the UI reads the same without colour.
- Ink runs in the alternate screen with `exitOnCtrlC` off (q and Ctrl-C quit through the app). SIGINT/SIGTERM/SIGHUP unmount Ink, which restores the screen, cursor and raw mode; `uncaughtException`/`unhandledRejection` additionally reset raw mode, show the cursor and leave the alternate screen before printing the error.

### Setup (`src/cli/setup.ts`)

At most three questions: install the hooks (with the add/replace summary), local AI (default model, custom URL and model, or off; Ollama is probed and a missing model prints the exact `ollama pull` command), and a test focus of the current terminal when a focus route exists (with the macOS Automation note). The token is created silently. `--yes` installs hooks, keeps AI on and skips the focus test. Re-running pre-fills the current answers. The flow is a pure function over an injected `Prompter`, so every branch is tested.

## 9. Configuration

Most users only answer the setup questions. Everything else has defaults and can be overridden with environment variables or the config file.

Files (directories 0700, files 0600):

| | Linux | macOS |
| --- | --- | --- |
| config dir: `config.json`, `ingest-token`, `ingest-header` | `$XDG_CONFIG_HOME/attention-manager` (default `~/.config/…`) | `~/Library/Application Support/attention-manager` |
| state dir: `attention.db` | `$XDG_STATE_HOME/attention-manager` (default `~/.local/state/…`) | same as config dir |
| logs: `receiver.log` | `<state dir>/logs` | `~/Library/Logs/attention-manager` |

Explicit `XDG_CONFIG_HOME`/`XDG_STATE_HOME` win on macOS too; `ATTENTION_CONFIG_DIR` and `ATTENTION_STATE_DIR` override both. `config.json` is validated by zod (`src/cli/config.ts`): `{version: 1, classifier: {enabled, ollamaUrl, model}, terminal: {confirmed}, bell, receiver: {port}}`; an invalid file stops every command except `setup` and `doctor` with exit 2.

Precedence for receiver settings: environment variable, then config file, then built-in default. Bounds are clamped.

| Variable | Default | Range / meaning |
| --- | --- | --- |
| `RECEIVER_HOST`, `RECEIVER_PORT` | `127.0.0.1`, config `receiver.port` (`4318`) | non-loopback hosts log a warning |
| `ATTENTION_RECEIVER_URL` | derived from the port | hook and CLI target override |
| `DATABASE_PATH` | state dir `attention.db` | `:memory:` allowed |
| `INGEST_TOKEN_PATH` / `ATTENTION_INGEST_TOKEN` | config dir `ingest-token` | token file or literal override |
| `MAX_BODY_BYTES` | `262144` | 1 KiB to 10 MB |
| `EVENT_HISTORY_LIMIT` | `50` | per session |
| `STALE_AFTER_MS` | `600000` | |
| `DEDUPE_WINDOW_MS` | `5000` | `0` disables |
| `RATE_LIMIT_PER_SESSION`, `RATE_LIMIT_GLOBAL` | `120`, `1200` | events per minute |
| `MAX_SESSIONS`, `RETENTION_DAYS` | `1000`, `7` | eviction cap, purge age |
| `OLLAMA_URL`, `OLLAMA_MODEL` | config `classifier.*` | non-loopback URL logs a warning |
| `CLASSIFY_TIMEOUT_MS` | `15000` | 0.5 s to 10 min |
| `CAPTURE_TASK_CONTEXT` | `1` | `0` disables task context and severity |
| `ATTENTION_HOOK_TIMEOUT` | `2` | hook POST timeout in seconds |
| `CLAUDE_SETTINGS_PATH` | `~/.claude/settings.json` | where hooks are installed |
| `NO_COLOR`, `TERM` | | colour and glyph fallbacks |
| `LOG_LEVEL` | `info` | payloads are never logged |

The receiver always has a token: `attention receiver` creates one when it is missing, so the old `ATTENTION_ALLOW_NO_TOKEN` path is no longer reachable from the CLI.

## 10. Security model in brief

Trust boundaries: hook forwarder → receiver (attacker-influenceable text and terminal identity, identity by token), receiver → Ollama (clamped text out, untrusted JSON in), receiver → TUI (strings originating from events or the model, rendered as terminal text), TUI → focus commands (stored terminal identity becomes command arguments).

Controls: loopback bind for both processes; Host and Origin checks; token in a 0600 header file; Content-Type gate; byte-counted body limit; rate limits; session and SSE caps; retention purge; schema stripping of everything not used; sanitization and secret redaction; delimited and escaped model input; schema-validated model output that can only raise priorities above rule floors and never changes status; terminal identity is allow-listed per field and only ever reaches `execFile` argument arrays (never a shell, AppleScript values only via argv) with a timeout; the hook command written to settings.json is built only from paths without quote or shell metacharacters; the TUI strips control characters from what it echoes (label query) and renders event text through Ink, which does not interpret it.

Accepted residual risks: a same-uid process can read the token and forge events, including a terminal identity that makes focus select a different (but allow-listed) tmux pane or window; model verdicts can still carry misleading wording within the floors; SQLite is unencrypted beyond file mode; focusing on X11 by process ancestry can pick another window of a multi-window terminal emulator.

## 11. Testing and evaluation

| Suite | Covers |
| --- | --- |
| `tests/normalize.test.ts` | mapping, rejection, summaries, sanitization, dedupe keys, task context |
| `tests/state-machine.test.ts` | every transition, delayed and out-of-order sequences, floors, task severity, sorting |
| `tests/risk.test.ts` | keyword rules |
| `tests/persistence.test.ts` | round-trips, pruning, dedupe lookup, purge, restart recovery |
| `tests/classifier.test.ts`, `tests/classifier-eval.test.ts` | output parsing, prompt building, client errors and timeouts, fixtures with a mocked model |
| `tests/receiver.test.ts` | HTTP controls, dedupe, rate limits, SSE, caps, concurrency bursts, classifier paths, restart, task severity end to end |
| `tests/terminal-*.test.ts`, `tests/hook-forwarder.test.ts` | terminal sanitising, env fixtures per terminal, process-tree walk, payload minimisation, store migration, the forwarder against a live receiver |
| `tests/cli-focus.test.ts` | adapter selection per platform/terminal/compositor and the exact argv each adapter runs, via a fake exec |
| `tests/cli-*.test.ts` | paths and platform guard, config, hooks merge/status, args and exit codes, SSE parser and backoff, lifecycle decisions, list/focus/hooks commands against a live receiver, doctor checks, setup flow with a fake prompter, sort/filter/format ports, colour rules |
| `tests/tui-*.test.ts(x)` | reducer, key map, Screen renders (wide, narrow, empty, connecting, degraded, offline, help, label query, no-colour) |
| `tests/cli-smoke.test.ts` | the built `dist/cli/main.js` and `dist/hook/main.js` in an isolated HOME (skipped until `pnpm build` has run) |

Live model evaluation (needs Ollama): `node scripts/eval-classifier.ts [--task] <model…>` against `tests/fixtures/classifier-cases.json` and `tests/fixtures/task-cases.json`.

Commands: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, or all of them plus `npm pack --dry-run` with `pnpm verify`.

## 12. Operational notes

- From a checkout, `pnpm attention` runs the CLI from source (`node src/cli/main.ts`); hooks installed from a checkout point at `src/hook/main.ts`.
- The receiver warms the model at startup (first load can take 5 to 15 s on this hardware; later calls are about 1 to 3 s).
- The spawned receiver's output goes to the receiver log (section 9).
- Teardown: `attention hooks uninstall`, `npm rm -g attention-manager`, then delete the config, state and log directories; optionally remove the user-local Ollama.
