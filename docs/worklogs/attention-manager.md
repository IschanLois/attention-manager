# Worklog: Claude Code Attention Manager

**Tracking number:** none (project opted out of Jira/Linear ids)
**Branch:** `feat/attention-manager`
**Started:** 2026-10-09

## Purpose

Implement the PRD (`PRD.md`): a local-first dashboard that ingests Claude Code hook events, keeps a deterministic per-session state, optionally classifies ambiguous events with a local Ollama model, and shows which session needs the developer's attention.

## Baseline (verified 2026-10-09)

- Toolchain: Node 24.12 (native TypeScript execution and `node:sqlite` available), pnpm 11.6, Claude Code 2.1.295.
- Hardware: 8 cores, 23 GiB RAM, NVIDIA GTX 1650 (4 GiB VRAM, 3.6 GiB usable per Ollama).
- Ollama was not installed. A user-local copy (v0.40.2) was unpacked to `~/.local/opt/ollama` with models in `~/.local/opt/ollama/models`; it runs as the user on `127.0.0.1:11434`.
- The user's global PreToolUse hook blocks any tool from touching `.env*` paths. The committed template is therefore `env.example` (no leading dot); README tells users to copy it to `.env`.

### Hook events captured from real sessions

Captured with a scratch project whose hooks append stdin to a log, in headless (`claude -p`) and interactive (pty-driven) sessions.

| Event | Fires | Notable payload fields |
| --- | --- | --- |
| `SessionStart` | session start | `source` (`startup`, also `resume`, `clear`, `compact` exist in the binary) |
| `UserPromptSubmit` | each prompt | `prompt`, `prompt_id`, `permission_mode` |
| `PreToolUse` / `PostToolUse` | around tools | `tool_name`, `tool_input`, `tool_use_id`, `tool_response`, `duration_ms` |
| `PostToolUseFailure` | tool error | `tool_name`, `error`, `is_interrupt`, `duration_ms` |
| `PermissionRequest` | tool needs approval (both headless and interactive) | `tool_name`, `tool_input`, `permission_suggestions` |
| `Notification` | interactive only | `message` (generic, e.g. "Claude needs your permission"), `notification_type` (`permission_prompt`; binary also contains `idle_prompt`, `elicitation_dialog`) |
| `Stop` | assistant turn finished | `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons` |
| `SubagentStop` | subagent finished | same common fields |
| `SessionEnd` | session exits | `reason` (`other`, `prompt_input_exit`; binary also has `clear`, `logout`) |
| `InstructionsLoaded` | CLAUDE.md load | `file_path`, `memory_type`, `load_reason` (ignored) |

Common fields on every event: `session_id` (UUID), `transcript_path`, `cwd`, `hook_event_name`, often `prompt_id`, `permission_mode`, `effort`.

Observations that shaped the design:

- `Stop` is a turn boundary, not termination; `SessionEnd` is the only reliable end signal.
- `Notification` carries no tool name, so `PermissionRequest` is the primary permission signal and `Notification(permission_prompt)` is deduplicated against it.
- Headless sessions never emit `Notification`.
- A session inherits the parent's permission mode via `CLAUDE_CODE_*` env vars; the probe had to clear them to see permission prompts.

## Decisions

(Updated as work proceeds.)

1. Two processes with one package: a plain Node receiver (`src/receiver`, run directly by Node 24 with type stripping) and the Next.js dashboard, which proxies `/api/*` to the receiver so the browser only talks to its own origin. No CORS anywhere.
2. Persistence uses the built-in `node:sqlite` to avoid native builds. It is still marked experimental by Node; the warning is silenced in the scripts.
3. Cache Components are disabled in `next.config.ts`; every dashboard route is dynamic.
4. Classifier model: Agent A recommended `qwen2.5:1.5b`; the live evaluation (19 fixtures) favoured `qwen3:1.7b` with thinking disabled (16/19 attention, 18/19 priority, 1.5 s median) so it is the default. `qwen2.5:1.5b` is documented as the lighter fallback; `qwen3:4b` was accurate on attention but too slow on 4 GB VRAM (6.6 s median).

5. Host/Origin/token controls live in the receiver itself (not only in the dashboard proxy) because any local process or browser tab can reach loopback ports.
6. `Stop` payloads carry `last_assistant_message`; a finished turn whose message looks like a question is rated medium by rule and sent to the classifier for refinement. Plain completions never touch the model.
7. Classifier output is validated (schema, enums, lengths, confidence range) and can only raise priority above the deterministic floor of the triggering event; it never changes status and is ignored once a newer event arrives for that session.
8. Out-of-range confidence is rejected rather than clamped; the dashboard shows AI confidence as an uncalibrated percentage.
9. Node parameter properties and other non-erasable TypeScript syntax are banned (`erasableSyntaxOnly`) so the receiver runs on plain Node without a build step.

## State transitions and precedence

| Event | From any state | Notes |
| --- | --- | --- |
| `session_start` | starting | also reopens an ended session (resume), clears failures |
| `prompt`, `tool_start` | working | clears attention and classification |
| `tool_end` | working | ignored when the turn is already completed and no permission was pending (delayed event) |
| `tool_failure` | error / low | 3 in 2 min escalate to medium; `is_interrupt` maps to idle / low |
| `permission_request` | needs_attention / high | remembers tool_use_id; resolved by tool_end, tool_start, prompt, or turn_complete |
| `notification` | depends on type | permission_prompt high (dedupes against a pending permission), elicitation_dialog high, idle_prompt medium, auth_success no-op, unknown types medium placeholder (source fallback) pending classification |
| `turn_complete` | completed / low | medium when the last message looks like a question |
| `subagent_stop`, `compact` | unchanged | only bump last-seen |
| `session_end` | ended / none | sticky: later events only bump last-seen until a new `session_start` |

Events are ordered by arrival at the receiver (hooks carry no timestamps). Duplicate dedupe keys inside the dedupe window are dropped before they reach the state machine. Staleness is computed at read time from last-seen, never stored.

## Changes

### Milestone 1 and 2: ingestion and state (commits 6b06348, 0dff367)

- `src/core/schemas.ts`: hook payload schema, normalized event, session, classification schema and JSON schema.
- `src/core/events/normalize.ts`: hook to event mapping, sanitization and redaction, summaries, dedupe keys.
- `src/core/sessions/state-machine.ts`: transitions, priority floors, classification policy, stale and sort helpers.
- `src/core/persistence/store.ts`: `node:sqlite` store with bounded history and dedupe lookup.
- `src/receiver/*`: HTTP server, ingest pipeline with coalesced classification queue, SSE hub, rate limiter, config.
- `scripts/claude-hook.sh`, `scripts/claude-hook-fallback.mjs`, `scripts/setup-hooks.ts`: forwarder and installer.
- Verified end to end with a real headless session: 12 events accepted, permission requests captured, session ended cleanly.

### Milestone 4: classification (commit 03aca82)

- `src/core/classifier/contract.ts`: system prompt with delimited untrusted data, few-shot examples, output parsing and clamping.
- `src/core/classifier/ollama.ts`: `/api/chat` client with JSON-schema `format`, timeout, error classification, health probe.
- `tests/fixtures/classifier-cases.json` plus `scripts/eval-classifier.ts` for live evaluation.
- Live results on this machine (19 cases): qwen3:1.7b 16/19 attention and 18/19 priority, p50 1.5 s; qwen2.5:1.5b 15/19 and 15/19, p50 1.2 s; qwen2.5:3b 15/19 and 15/19, p50 1.6 s; qwen3:4b-instruct 17/19 and 14/19, p50 6.6 s. The Qwen2.5 models under-detect question-like turn ends, which the deterministic rule already covers.
- Thinking-capable models get `think: false`, detected once per model via `/api/show` capabilities.

### Milestone 5: security hardening (commit after review)

Agent C's threat model confirmed the receiver controls (loopback bind, Host and Origin checks, token with constant-time compare, Content-Type gate, byte-counted body limit, rate limits, dedupe, schema stripping of prompt/tool fields, delimited untrusted model input, validated output with priority floors). Gaps fixed:

| Finding | Fix |
| --- | --- |
| Next bound to all interfaces | `next dev/start -H 127.0.0.1`, telemetry disabled |
| Unbounded SSE clients | cap (default 16), 503 beyond it |
| Unbounded sessions | cap (default 1000) with ended/oldest eviction; ended sessions and events purged after `RETENTION_DAYS` (7) at startup and hourly |
| Token visible in curl argv | installer writes `data/ingest-header` (0600); hook uses `curl -H @file` |
| No security headers on the dashboard | CSP, Referrer-Policy, nosniff, X-Frame-Options in `next.config.ts`; `react/no-danger` lint error |
| Bidi/zero-width characters survive sanitization | stripped in `sanitizeText` |
| 64 KB body limit drops large `Stop` payloads | default raised to 256 KB |
| Missing token silently disabled auth | receiver exits unless `ATTENTION_ALLOW_NO_TOKEN=1` |
| Prompt attribute injection, `%zz` 500 | attributes stripped of quotes/angle brackets; 400 on bad encoding |

Accepted residual risks: a same-uid process can read the token and forge events; the model can still word a misleading reason within the deterministic floor; dev-mode CSP allows inline/eval; payload fields still cross the loopback socket before being dropped; SQLite is unencrypted at rest beyond file mode 0600.

### Milestone 3: dashboard (commit 2e6adba)

Built by a delegated agent against Agent B's spec and reviewed by the lead: server-rendered snapshot, SSE hook with backoff and manual reconnect, priority-first ordering recomputed client-side, "Observed" versus "AI · nn%" versus "Unclassified" badges, stale and disconnected treatments, filter chips persisted in the URL, collapsed ended group, detail drawer with bounded event history, diagnostics strip, and degraded banners for an unreachable or missing model, SQLite errors and a lost receiver. Route handlers proxy the receiver so the browser never talks to port 4318. No `dangerouslySetInnerHTML`, no data-driven links. Deviations from the spec: health is polled every 60 s while live (the receiver only pushes health on connect); reduced motion is handled in CSS only.

### Milestone 5: correctness review fixes (commit aaf3dbf)

Independent review found three P1 bugs, all reproduced and fixed with regression tests:

- A finished or failed tool other than the one awaiting permission cleared the pending permission (parallel tool calls made this common).
- Dedupe keys were constant for every `Stop`, `prompt` and `SubagentStop` of a session, so a later turn end inside the window was dropped and the session stuck in "working". Keys now include the prompt id and a hash of the message; subagent stops and compactions are exempt.
- The Ollama client cleared its timeout once headers arrived, so a stalled body could hang the single-worker queue forever. The whole exchange now runs under one timeout.

P2 fixes: classification results are matched by a per-session event sequence instead of timestamps; unknown notifications no longer demote a pending permission; `SessionStart(compact)` is a no-op and resume keeps the first start time; MCP tool names longer than 40 characters are no longer redacted (identifiers get a separate sanitizer); oversized text fields are truncated instead of rejecting the event; the pipeline awaits in-flight jobs on close; chunked over-limit bodies get 413; the installer keeps only the first backup, writes atomically and leaves foreign hook groups alone; the hook script drops prompt and tool payload fields with jq before sending.

Accepted deviations: events carry no `occurred_at` because hooks have no timestamps (receiver arrival order is used); `started_at` is null for sessions first seen mid-flight; a turn that ends after escalated failures shows "completed" and the failure context is only visible in the event history.

### Integrated verification (2026-10-09)

- `pnpm test`: 128 tests in 8 files pass. `pnpm typecheck`, `pnpm lint`, `pnpm build` pass.
- `pnpm dev` (receiver + dashboard) with a real interactive Claude Code session: the permission prompt appeared on the dashboard as "Needs attention / HIGH" with the session label; the proxied SSE stream delivered snapshot and health frames; CSP, Referrer-Policy and X-Frame-Options headers were present.
- `pnpm doctor` against the running stack passed every check except "hooks", which correctly reports that the user's real `~/.claude/settings.json` has not been touched (hooks were only installed into a scratch project during development).

### Diagnostics and docs (commit 03aca82)

- `scripts/doctor.ts`, `scripts/dev.mjs`, README with setup, run, troubleshooting and teardown.

## Known limitations and follow-ups

- The receiver trusts any same-uid process that can read the token; a Unix domain socket would replace Host, Origin and token checks with filesystem permissions.
- The model only refines ambiguous events; small models still misjudge some fixtures (see the evaluation table in the README). Prompt tuning or a larger model is a configuration change.
- Dev-mode CSP needs `'unsafe-inline' 'unsafe-eval'`; a nonce-based CSP would need middleware.
- Hook payload fields were verified against Claude Code 2.1.295 only; re-run `tests/fixtures` capture on upgrades.
- `Notification` hooks do not fire in headless (`-p`) sessions; `PermissionRequest` does, so headless sessions are still covered.
- No tests exist yet for `scripts/setup-hooks.ts` or the hook shell script beyond manual runs.

## Test plan

### Automated

- `pnpm test` (Vitest): event normalization, state transitions, deduplication, classifier validation, security validation.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`.

### Manual (performed 2026-10-09)

- Headless `claude -p` session in a scratch project with hooks installed: 12 events accepted through `claude-hook.sh` with the token header file; permission requests for Bash and Write captured; session ended cleanly.
- Interactive pty-driven session ending with "Should I create the missing file for you?": rule set the turn to completed/medium, then qwen3:1.7b classified it as AI-sourced with confidence 0.8 while the session stayed open; model warm-up took 1.3 s after restart.
- Receiver restarted three times during development; sessions were restored from `data/attention.db` each time.
- `pnpm doctor` reports receiver, hooks, token, SQLite, model, last event and last classification error.


- Install hooks, start receiver and dashboard, run two Claude Code sessions, trigger a permission prompt, confirm the card turns to "Needs attention" without reload.
- Stop the receiver while a session runs; Claude Code keeps working.
- Stop Ollama; deterministic states keep updating and the dashboard shows the degraded banner.
- Restart the receiver; sessions are restored from SQLite.
