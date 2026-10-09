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
- **Ranking**: active, then done (`completed` or `idle`), then ended; within each group task severity, then attention priority, then fresh before stale, then recency. See "Risk-first ranking" below.
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

## Risk-first ranking

**Branch:** `feat/risk-first-sort` (from `main`)
**Date:** 2026-10-10

### Purpose

Attention priority mostly reflects whether a session is waiting for input (permission prompt high, idle prompt medium). As the first sort key, it let a session waiting on a harmless permission prompt outrank one doing critical work. The user asked for the LLM risk assessment to drive the order, with sessions that are done thinking kept at the bottom.

### Decisions

- Sessions are grouped into phases. Active comes first: `starting`, `working`, `needs_attention` and `error`. Done comes next: `completed` (turn complete) and `idle` (interrupted). Ended sessions come last. The agent is no longer working in a done session, so it goes below every active one, whatever its risk.
- Within a phase, `taskSeverity` is the primary key. Attention `priority` only breaks ties between sessions of equal risk. Freshness, recency and id follow, as before.
- The client copy (`src/cli/model/sort.ts`) and the server copy (`src/core/sessions/state-machine.ts`) are changed identically. The `recent` and `label` modes still use this order as their tie-break.
- The counters (`attentionCount`, `highRiskCount`) are unchanged.

### Changes

- `src/cli/model/sort.ts`: added `phaseRank`, and severity now comes before priority in `compareAttention`.
- `src/core/sessions/state-machine.ts`: the same change in `sortSessions`.
- `tests/cli-sort.test.ts` and `tests/state-machine.test.ts`: the expected orders changed. The new cases cover severity outranking priority, priority breaking ties, and completed or idle sessions sitting below active ones and above ended ones.

### Test plan

- **Automated:** `npm test`, which runs the sort tests for both copies.
- **Manual:** run the demo. A risky session such as risky-cleanup sits above a session waiting on a low-risk permission prompt. When a session's turn completes, it drops below every active session and stays above ended ones.

## Risk in the priority column, "Needs input" status

**Branch:** `feat/risk-first-sort`
**Date:** 2026-10-10

### Purpose

The PRIORITY column showed the attention priority. That value mostly says whether a session is waiting for input, which the STATUS column already shows. The user asked for the column to show the session's risk, and for the "Needs attention" status to read "Needs input".

### Decisions

- The PRIORITY column, in the TUI and in the `attention list` table, now shows `taskSeverity`. The `attention list --json` output still returns `priority` and does not add a field, so the versioned contract is unchanged.
- The per-row risk badge (`⚠ critical` or `!critical`) is removed because the column now carries the same information. The risk reason is still in the detail view.
- The TUI filter keys `1`-`4` now filter on risk (`filters.risks`), so they match the column. The CLI flags `--min-priority` and `--min-risk` are unchanged.
- The `needs_attention` label and the live announcement now say "Needs input" and "now needs input". The internal status value `needs_attention` is unchanged.

### Changes

- `src/cli/tui/components.tsx`: the column shows the risk, the badge is removed, and the filter summary reads `filters.risks`.
- `src/cli/tui/state.ts`: the priority shortcut keys set `filters.risks`.
- `src/cli/commands/list.ts`: the table's PRIORITY column shows the risk.
- `src/cli/model/types.ts` and `src/cli/model/announce.ts`: the "Needs input" wording.
- `README.md` and `docs/how-it-works.md`: the screenshot, key table, ranking and walkthrough.
- Tests: `tests/tui-render.test.tsx`, `tests/tui-state.test.ts`, `tests/cli-model.test.ts` and `tests/cli-commands.test.ts`.

### Test plan

- **Automated:**
  - The render test checks that a waiting session with high priority and critical risk shows `CRITICAL ... Needs input`, has no badge, and that the filter summary reads `priority critical+`.
  - The state test checks that the `1`-`4` keys set the risk filter.
  - The announcement and `list` tests check the "Needs input" wording.
- **Manual:** run the demo. The PRIORITY column matches the risk in the detail view, and the waiting sessions read "Needs input".
