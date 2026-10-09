# How the Claude Code Attention Manager works

This document explains what the application does and how its parts fit together, for someone who wants to use it or understand it before reading code. The engineering details live in [technical-implementation.md](./technical-implementation.md); setup and troubleshooting live in the [README](../README.md).

## The problem it solves

When several Claude Code sessions run in different terminal tabs, you cannot tell without looking which one is blocked on a permission prompt, which one just asked you a question, which one keeps failing, and which one is quietly doing something dangerous such as dropping a database table. The attention manager is a local dashboard that watches all of your sessions and answers two questions in real time:

1. **Which session needs me right now?** (attention priority)
2. **Which session should I keep an eye on?** (task severity)

Everything runs on your machine. Nothing is sent to a cloud service.

## The big picture

```
 Claude Code session A ─┐
 Claude Code session B ─┼─ hooks ─▶ claude-hook.sh ─▶ receiver (127.0.0.1:4318)
 Claude Code session C ─┘                                   │
                                                            │ state machine · risk rules
                                                            │ SQLite · local model (Ollama)
                                                            ▼
                                 browser ◀── dashboard (127.0.0.1:3000) ◀── live stream
```

Four pieces cooperate:

| Piece | What it is | What it does |
| --- | --- | --- |
| **Hooks** | Entries in `~/.claude/settings.json` installed by `pnpm hooks:install` | Make every Claude Code session call a tiny script whenever something notable happens |
| **Receiver** | A small Node.js service | Accepts those events, works out each session's state, stores it, and pushes changes to the dashboard |
| **Local model** | Ollama running a small model such as `qwen3:1.7b` | Reads the few ambiguous events and rates how risky a task is |
| **Dashboard** | A Next.js web page | Shows every session, ranked, with reasons, and updates without reloading |

## Step 1: Claude Code tells us what is happening

Claude Code has a hook system: at well-defined moments it runs a command you configure and passes a JSON description of the moment on standard input. The attention manager subscribes to eleven of those moments:

| Moment | Hook event | What it tells us |
| --- | --- | --- |
| A session starts or resumes | `SessionStart` | A new card may be needed |
| You submit a prompt | `UserPromptSubmit` | The agent is working; what the task is |
| The agent is about to run a tool | `PreToolUse` | Still working; what it is about to run |
| A tool finished or failed | `PostToolUse`, `PostToolUseFailure` | Progress, or an error to consider |
| A tool needs your approval | `PermissionRequest` | The session is blocked on you |
| Claude Code shows a notification | `Notification` | Permission prompts, idle prompts, dialogs |
| The agent finished its turn | `Stop` | Done for now; what it said last |
| A subagent finished, context was compacted | `SubagentStop`, `PreCompact` | Activity only |
| The session ends | `SessionEnd` | The card can be retired |

The hook command is `scripts/claude-hook.sh`. It trims the payload down to what the receiver uses (never tool outputs, file contents or transcripts), posts it to the receiver with a shared secret, and exits successfully within two seconds no matter what. If the receiver is down, Claude Code never notices.

## Step 2: The receiver turns events into session state

The receiver keeps one record per session and updates it with a fixed set of rules. The rules are deterministic: the same events always produce the same state, with no model involved.

### Status: what the session is doing

| Status | Meaning |
| --- | --- |
| Starting | Started, nothing else known yet |
| Working | A prompt was submitted or a tool is running |
| Needs attention | Waiting for a permission decision, an answer in a dialog, or your input |
| Error | A tool failed; three failures in two minutes escalate |
| Completed | The turn finished. The session is still open and waiting for the next prompt. This is **not** the same as ended |
| Idle | You interrupted the agent |
| Ended | The session exited |

### Attention priority: how urgently you are needed

| Priority | Typical cause |
| --- | --- |
| Critical | Waiting for permission to run something destructive, or a critical-risk task is blocked on you |
| High | Waiting for permission, or a dialog needs input |
| Medium | Waiting for your input after idling, repeated failures, or the agent appears to have asked a question |
| Low | A turn finished or a single tool failed |
| None | Working normally |

The priority comes with a one-line reason ("Waiting for permission to run Bash") and a source badge: **Observed** when it came from a rule, **AI** with a confidence when the local model refined it, **Unclassified** when the model was unavailable.

### Task severity: how consequential the work is

Independently of whether the session is blocked, each session gets a **Risk** level based on what the agent is doing:

- **Critical**: can destroy or corrupt data or touch production: `DROP`/`ALTER`/`TRUNCATE`, "drop the users table", `DELETE FROM`, `rm -rf`, force pushes, hard resets, production deploys, Terraform and kubectl mutations.
- **High**: migrations, authentication, billing, secrets, `sudo`, piping curl into a shell, publishing packages.
- **Medium**: dependency changes, branch operations, broad refactors.
- **Low**: everything else once a task is known.
- **None**: nothing known yet.

The context used is small: the latest prompt, the last five tool actions ("Bash: psql -c 'DROP TABLE legacy_users'", "Write: src/db/migrate.ts") and the agent's last message. Keyword rules set a floor; the local model may raise that floor by one level after reading the same context, never lower it.

## Step 3: The local model handles only the ambiguous cases

Most events are unambiguous and never reach the model. The model is asked only when a human would have to read text to decide:

- a notification of an unknown type,
- a tool failure with error text (is this a routine missing file or a real blocker?),
- a finished turn whose last message looks like a question,
- a new prompt or a finished turn, to rate the task's severity.

Its answer is a strict JSON object that is validated before use. It can change a label, a reason and a confidence. It can never change a session's status, lower a rule-based priority, run a command, or approve anything. If it is slow, missing or wrong, the rule-based state stays and the dashboard says so.

## Step 4: The dashboard shows it

The page at http://localhost:3000 lists every session as a card, ordered so the most important is on top:

1. active sessions before ended ones,
2. higher attention priority first,
3. within the same priority, higher task severity first,
4. fresh before stale,
5. most recent first.

Each card shows the project name, a short session id, the status, the priority badge, the risk badge, the reason, how long ago the last event arrived, and the task in one line. Selecting a card opens a panel with the recent events, the classification evidence, the recent actions and the agent's last message, so you can decide which terminal to switch to.

The header counts how many sessions need attention and how many are high-risk; the browser tab title carries the attention count. Filters by status, priority and risk live in the URL so a narrow side window can stay pre-filtered.

### Honest about uncertainty

- A card whose session has been silent for longer than the staleness threshold (ten minutes by default) says "may be out of date" instead of pretending it is still working.
- When the dashboard loses the receiver, a banner says so and every card is treated as stale until the stream reconnects.
- When the model is unreachable or not installed, a banner says classification is rule-based only.
- Observed facts and model verdicts are labelled differently everywhere.

## What it deliberately does not do

- It never approves permissions, runs commands, or switches terminals for you.
- It never sends prompts, code or events off your machine.
- It never stores tool outputs, file contents, transcripts or full paths. Task context can be turned off entirely with `CAPTURE_TASK_CONTEXT=0`.
- It never blocks Claude Code: a dead receiver costs each hook at most two seconds and is otherwise invisible.

## A typical session, end to end

1. You run `pnpm dev` and open the dashboard. It is empty with instructions.
2. You start Claude Code in a project and type "Write a migration that drops the legacy_users table". A card appears: **Working**, **Risk: critical** (keyword "drops the legacy_users table"), task line visible. A moment later the model agrees and the badge says "AI · 85%".
3. The agent asks to run `psql`. The card becomes **Needs attention / CRITICAL** with the reason "Waiting for permission to run Bash (critical-risk: Matched "DROP TABLE")", jumps to the top, and the tab title shows "(1)".
4. You switch to that terminal and decide. The tool runs or is denied; the card returns to **Working**.
5. The agent finishes with "Should I also remove the backup table?". The card shows **Completed / Medium**, "appears to be asking a question", then the model confirms it is a question for you.
6. You close the session. The card moves to the collapsed **Ended** group and is purged after seven days.
