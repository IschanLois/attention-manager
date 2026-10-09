# Worklog: Task severity ranking

**Tracking number:** none (project opted out of Jira/Linear ids)
**Branch:** `feat/task-severity` (from `feat/attention-manager`)
**Started:** 2026-10-09

## Purpose

The attention manager ranked sessions only by attention state (permission prompt, question, failure). The user asked for severity-aware ranking: the dashboard should show in real time which coding agents deserve watching based on what each agent is doing, for example one running DDL against a database.

## Design

- **Context gathered per session** (sanitized, redacted, length-capped, stored in SQLite):
  - `taskSummary`: the latest user prompt, first 300 characters captured, 160 shown.
  - `recentActions`: the last five tool actions as "Tool: command or path" snippets.
  - `lastNarration`: the assistant's last message snippet from `Stop`.
- **Deterministic risk rules** (`src/core/sessions/risk.ts`) match keywords in prompts, commands and narration: DDL, `rm -rf`, force push, hard reset, production deploys and `DELETE FROM` are critical; migrations, auth/secrets/billing code, `sudo`, piping curl into a shell and publishing are high; dependency changes, branch switches and broad refactors are medium.
- **Task severity** (`taskSeverity`) starts from the keyword floor (`taskRuleSeverity`) and the local model may raise it, never lower it. A new prompt resets the task context. The model is asked once per prompt and once per finished turn, coalesced per session.
- **Attention escalation**: a permission request whose command or task is critical-risk is shown as attention priority critical instead of high.
- **Ranking**: active before ended, attention priority, then task severity, then fresh before stale, then recency.
- **Privacy change**: the hook script now forwards `tool_input.command`, `tool_input.file_path`, `tool_input.description`, the prompt (first 400 chars) and the last assistant message (first 600 chars) instead of dropping them. `CAPTURE_TASK_CONTEXT=0` turns the capture off at the receiver, in which case severity stays at `none`.

## Model evaluation (12 task fixtures, `scripts/eval-classifier.ts --task`)

| Model | priority correct | median latency | misses |
| --- | --- | --- | --- |
| qwen3:1.7b, first prompt | 6/12 | 2.7 s | over-rated tests/refactors/dependency bumps as high, under-rated deletes |
| qwen3:1.7b, conservative prompt with examples | 9/12 | 2.5 s | dependency bump and refactor rated high; prompt-injection fixture rated none |
| qwen2.5:3b, conservative prompt | 10/12 | 4.8 s | `DELETE FROM` rated low; secret rotation rated medium |

Decision: keep `qwen3:1.7b` (latency) and bound its influence. Every dangerous fixture is already caught by the keyword rules (DDL, `rm -rf`, force push, `DELETE FROM`, production deploy, secrets), so the model's remaining failure mode is over-rating routine work. The model may therefore raise the keyword floor by at most one level; critical severity always needs keyword evidence or a high floor.

## Changes

- `src/core/schemas.ts`: task fields on `NormalizedEvent` and `Session`.
- `src/core/sessions/risk.ts`: keyword rules, `assessRisk`, `highestRisk`, `describeRisk`.
- `src/core/events/normalize.ts`: task context extraction from prompts, tool inputs (command, path, description) and the last assistant message, with risk hits.
- `src/core/sessions/state-machine.ts`: task reset on prompt, action history, severity floor and raises, permission escalation to critical, task classification policy, one-level cap on model raises, severity as a sort key.
- `src/core/classifier/contract.ts`, `ollama.ts`, `types.ts`: task-severity prompt and `classifyTask`.
- `src/core/persistence/store.ts`: new columns with idempotent migrations.
- `src/receiver/pipeline.ts`, `server.ts`, `config.ts`, `main.ts`: task classification jobs (coalesced per session, separate from attention jobs) and `CAPTURE_TASK_CONTEXT`.
- `scripts/claude-hook.sh`: forwards command/path/description, a prompt snippet and a narration snippet instead of dropping them.
- Dashboard (`src/components`, `src/lib`): risk badge with source, task line, risk filter, high-risk header count, severity ordering, detail sections, aria-live announcement for critical-risk work.
- Tests: `tests/risk.test.ts`, task cases in normalize/state-machine/classifier/receiver tests, `tests/fixtures/task-cases.json`, dashboard tests.

## Test plan

### Automated

- Risk keyword rules, task context extraction in the normalizer, state machine task fields and permission escalation, task classifier prompt and validation, receiver end-to-end (rule floor, AI raise, capture off), dashboard sort and mount tests.

### Manual

- Start two sessions, one editing a README and one asked to write a DDL migration; the DDL session shows a red "Risk: critical" badge and sorts first among working sessions; when it asks permission to run `psql`, its attention priority becomes critical.
