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
4. Classifier model: `qwen2.5:1.5b` by default (Agent A), `qwen2.5:3b` documented as the higher-quality option.

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
- Live results on this machine (19 cases): qwen2.5:1.5b 15/19 correct, p50 1.2 s; qwen2.5:3b 15/19, p50 1.6 s. Both under-detect question-like turn ends, which the deterministic rule already covers.

### Diagnostics and docs (commit 03aca82)

- `scripts/doctor.ts`, `scripts/dev.mjs`, README with setup, run, troubleshooting and teardown.

## Test plan

### Automated

- `pnpm test` (Vitest): event normalization, state transitions, deduplication, classifier validation, security validation.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`.

### Manual

- Install hooks, start receiver and dashboard, run two Claude Code sessions, trigger a permission prompt, confirm the card turns to "Needs attention" without reload.
- Stop the receiver while a session runs; Claude Code keeps working.
- Stop Ollama; deterministic states keep updating and the dashboard shows the degraded banner.
- Restart the receiver; sessions are restored from SQLite.
