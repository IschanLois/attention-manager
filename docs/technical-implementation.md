# Technical implementation

Engineering reference for the Claude Code Attention Manager. For the conceptual overview see [how-it-works.md](./how-it-works.md); for setup see the [README](../README.md); for decisions and verification history see the worklogs in `docs/worklogs/`.

## 1. Stack and runtime

| Concern | Choice | Notes |
| --- | --- | --- |
| Language | TypeScript 5.9, strict, `erasableSyntaxOnly` | Core and receiver run directly under Node 24 with type stripping; no build step, no parameter properties or enums |
| Receiver | Plain `node:http` | No framework; one process, loopback only |
| Persistence | `node:sqlite` (`DatabaseSync`) | Built into Node 24; no native build. Still flagged experimental by Node, warning silenced in scripts |
| Validation | zod 4 | Hook payloads and model output |
| Dashboard | Next.js 16 App Router, React 19, Tailwind 4 | Cache Components disabled; every route dynamic; no UI dependencies |
| Model runtime | Ollama HTTP API | `qwen3:1.7b` default, configurable |
| Tests | Vitest 5, happy-dom for one DOM mount test | 160 tests |
| Package manager | pnpm 11 | Single package, no workspace |

Module layout:

```
src/core/            pure domain code, imported by both processes (relative .ts imports)
  schemas.ts         zod schemas, enums, Session/NormalizedEvent types, classifier JSON schema
  events/normalize.ts   hook payload -> NormalizedEvent, sanitization, redaction, task context
  sessions/state-machine.ts  reduceSession, classification policy, floors, sorting
  sessions/risk.ts   keyword risk rules
  sessions/view.ts   SessionView (adds `stale`), snapshot shapes
  classifier/        contract (prompts, output parsing), ollama client, port types
  persistence/store.ts  SQLite store
  logger.ts
src/receiver/        HTTP service: server.ts, pipeline.ts, sse.ts, rate-limit.ts, config.ts, main.ts
src/app/             Next.js pages and proxy route handlers
src/components/      dashboard components (client)
src/lib/             dashboard helpers and hooks (sort, filters, format, stream)
scripts/             hook forwarder, installer, doctor, dev launcher, model evaluation
tests/               Vitest suites and fixtures captured from real hooks
```

## 2. Event ingestion

### 2.1 Hook configuration

`scripts/setup-hooks.ts install` merges one command hook per event into the settings file (`~/.claude/settings.json` by default, or `CLAUDE_SETTINGS_PATH`). Each entry is:

```json
{ "hooks": [{ "type": "command", "command": "/abs/path/scripts/claude-hook.sh", "timeout": 5 }] }
```

Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Notification`, `Stop`, `SubagentStop`, `PreCompact`, `SessionEnd`.

Installer guarantees: existing hooks are kept; only groups emptied by removing our own entry are dropped; the first install writes `settings.json.attention-backup` once; writes go to a temp file then `rename`; the ingest token (`data/ingest-token`, 0600) and a curl header file (`data/ingest-header`, 0600, content `x-attention-token: <token>`) are generated or regenerated when empty.

### 2.2 Forwarder

`scripts/claude-hook.sh` reads stdin, reduces it with `jq` when available, and posts it:

- kept: everything except `tool_response` and `transcript_path`; `tool_input` is replaced by `{command, file_path, description}` (command ≤ 400 chars, description ≤ 200); `prompt` ≤ 400 chars; `last_assistant_message` ≤ 600 chars.
- `curl --max-time 2 --connect-timeout 1 -H @data/ingest-header --data-binary @-`; the token never appears in argv.
- Without curl, `scripts/claude-hook-fallback.mjs` does the same with `fetch` and `AbortSignal.timeout`.
- Always `exit 0`, never prints the payload.

### 2.3 Verified payload facts (Claude Code 2.1.295)

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

### 2.4 Receiver HTTP surface

| Route | Purpose | Controls |
| --- | --- | --- |
| `POST /api/events` | ingest | token (constant-time compare), `Content-Type: application/json`, body ≤ `MAX_BODY_BYTES` (byte-counted, chunked bodies get 413), global and per-session token buckets, dedupe |
| `GET /api/sessions` | sorted snapshot `{sessions, now, staleAfterMs}` | |
| `GET /api/sessions/:id` | `{session, events, now}` with bounded history | id regex, 400 on bad encoding, 404 unknown |
| `GET /api/health` | diagnostics (receiver, sqlite, model, last event, last classification error, session count) | |
| `GET /api/stream` | SSE: `snapshot`, `health`, `session`, `session_removed`, heartbeat comments | client cap (`maxSseClients`, default 16) |

All routes first require `Host` ∈ {localhost, 127.0.0.1, [::1], bound host} and a loopback `Origin` when present. No CORS headers are ever sent. Responses carry `nosniff` and `no-store`. Server timeouts: headers 5 s, request 10 s.

Responses to ingest: `202 {accepted:true}`, `200 {accepted:false, reason:"unsupported_event"|"duplicate"}`, `400 invalid_payload`, `401`, `403`, `413`, `415`, `429`.

### 2.5 Pipeline (`src/receiver/pipeline.ts`)

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
         task_severity_confidence, task_classified_at)
session_events(id PK, session_id, event_type, received_at, summary, dedupe_key)
```

Indexes on `last_seen_at`, `(session_id, id DESC)`, `(dedupe_key, received_at)`. WAL mode. New columns are added with idempotent `ALTER TABLE` migrations. Per-session history is pruned to `EVENT_HISTORY_LIMIT` on every insert. `purge(now, maxAge)` deletes ended sessions and old or orphaned events. The database file is chmod 0600 and its directory is created on demand; if the file cannot be opened the receiver falls back to `:memory:` and reports it in health.

## 8. Dashboard

### Server side

- `src/app/page.tsx` (server component) fetches the snapshot and health from `RECEIVER_URL` with try/catch and renders `<Dashboard>` with the initial state and the filters parsed from the URL. A failed fetch renders the disconnected state.
- Route handlers under `src/app/api/*` proxy `/api/sessions`, `/api/sessions/[id]` (id validated first), `/api/health` and `/api/stream` (streamed body, upstream aborted when the client disconnects). The receiver being unreachable yields `503 {"error":"receiver unreachable"}`. The browser never talks to port 4318.
- `next.config.ts` sets CSP (`default-src 'self'`, inline scripts allowed, eval only in dev, `connect-src 'self'`, `frame-ancestors 'none'`), `Referrer-Policy: no-referrer`, `nosniff`, `X-Frame-Options: DENY`. ESLint forbids `dangerouslySetInnerHTML`.

### Client side

- `useSessionStream`: `EventSource('/api/stream')`, exponential backoff 1 s to 30 s, `offline` after three failures, merges `session` frames by id, drops `session_removed`, polls health every 60 s while live, exposes `reconnect`/`refresh`. Announcement text for aria-live is computed by the pure `announcementFor` (transitions into needs_attention/error and into critical-risk work).
- `useClock`: one shared `useSyncExternalStore` ticker per cadence with stable subscribe/snapshot functions (an unstable subscribe caused a render loop; covered by a mount test).
- `src/lib/sort.ts` mirrors the receiver's ordering and recomputes staleness client-side; `src/lib/filters.ts` round-trips status/priority/risk/ended/sort through the URL.
- Components: `Dashboard` (state container), `HeaderBar`, `DegradedBanner`, `FilterToolbar`, `SessionList` (listbox with arrow-key navigation), `SessionCard`, `SessionDetail` (dialog with focus management), `DiagnosticsStrip`, `EmptyState`, `badges`, `icons`. Everything renders React-escaped text; no data-driven URLs.

## 9. Configuration

Read by `src/receiver/config.ts` (receiver) and `src/lib/receiver.ts` (dashboard). Bounds are clamped.

| Variable | Default | Range / meaning |
| --- | --- | --- |
| `RECEIVER_HOST`, `RECEIVER_PORT` | `127.0.0.1`, `4318` | non-loopback hosts log a warning |
| `RECEIVER_URL` | `http://127.0.0.1:4318` | dashboard proxy target |
| `PORT` | `3000` | Next.js |
| `DATABASE_PATH` | `./data/attention.db` | `:memory:` allowed |
| `INGEST_TOKEN_PATH` / `ATTENTION_INGEST_TOKEN` | `./data/ingest-token` | token file or literal override |
| `ATTENTION_ALLOW_NO_TOKEN` | unset | `1` allows unauthenticated loopback ingest; otherwise startup fails without a token |
| `MAX_BODY_BYTES` | `262144` | 1 KiB to 10 MB |
| `EVENT_HISTORY_LIMIT` | `50` | per session |
| `STALE_AFTER_MS` | `600000` | |
| `DEDUPE_WINDOW_MS` | `5000` | `0` disables |
| `RATE_LIMIT_PER_SESSION`, `RATE_LIMIT_GLOBAL` | `120`, `1200` | events per minute |
| `MAX_SESSIONS`, `RETENTION_DAYS` | `1000`, `7` | eviction cap, purge age |
| `OLLAMA_URL`, `OLLAMA_MODEL` | `http://127.0.0.1:11434`, `qwen3:1.7b` | non-loopback URL logs a warning |
| `CLASSIFY_TIMEOUT_MS` | `15000` | 0.5 s to 10 min |
| `CAPTURE_TASK_CONTEXT` | `1` | `0` disables task context and severity |
| `LOG_LEVEL` | `info` | payloads are never logged |

## 10. Security model in brief

Trust boundaries: hook script → receiver (attacker-influenceable text, identity by token), receiver → Ollama (clamped text out, untrusted JSON in), receiver → browser (strings originating from events or the model, rendered as text).

Controls: loopback bind for both processes; Host and Origin checks; token in a 0600 header file; Content-Type gate; byte-counted body limit; rate limits; session and SSE caps; retention purge; schema stripping of everything not used; sanitization and secret redaction; delimited and escaped model input; schema-validated model output that can only raise priorities above rule floors and never changes status; no code path executes anything derived from events or model output; CSP and security headers on the dashboard; lint rule against raw HTML.

Accepted residual risks: a same-uid process can read the token and forge events; model verdicts can still carry misleading wording within the floors; dev-mode CSP allows inline and eval; event text crosses the loopback socket before being trimmed when `jq` is absent; SQLite is unencrypted beyond file mode.

## 11. Testing and evaluation

| Suite | Covers |
| --- | --- |
| `tests/normalize.test.ts` | mapping, rejection, summaries, sanitization, dedupe keys, task context |
| `tests/state-machine.test.ts` | every transition, delayed and out-of-order sequences, floors, task severity, sorting |
| `tests/risk.test.ts` | keyword rules |
| `tests/persistence.test.ts` | round-trips, pruning, dedupe lookup, purge, restart recovery |
| `tests/classifier.test.ts`, `tests/classifier-eval.test.ts` | output parsing, prompt building, client errors and timeouts (including stalled bodies), thinking detection, fixtures with a mocked model |
| `tests/receiver.test.ts` | HTTP controls, dedupe, rate limits, SSE, caps, concurrency bursts, classifier failure and success paths, restart, task severity end to end |
| `tests/dashboard-*.test.ts(x)` | sort, filters, formatting, announcements, a happy-dom mount of the full dashboard |

Live model evaluation (needs Ollama): `node --no-warnings=ExperimentalWarning scripts/eval-classifier.ts [--task] <model…>` against `tests/fixtures/classifier-cases.json` and `tests/fixtures/task-cases.json`. Results on a GTX 1650 are recorded in the README and in `docs/worklogs/`.

Commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm doctor`.

## 12. Operational notes

- `pnpm dev` runs `scripts/dev.mjs`, which spawns the receiver (with `--env-file-if-exists=.env`) and `next dev -H 127.0.0.1` (Next loads `.env` itself; passing the Node flag to it breaks because Next forwards `NODE_OPTIONS` to a child).
- The receiver warms the model at startup (first load can take 5 to 15 s on this hardware; later calls are about 1 to 3 s).
- `pnpm doctor` checks receiver, hooks, token, SQLite, model runtime and model, last event and last classification error, and posts an authenticated probe event.
- Teardown: `pnpm hooks:uninstall`, delete `data/`, optionally remove the user-local Ollama.
