# How the Claude Code Attention Manager works

This document explains what the application does and how its parts fit together, for someone who wants to use it or understand it before reading code. The engineering details live in [technical-implementation.md](./technical-implementation.md); setup and troubleshooting live in the [README](../README.md).

## The problem it solves

When several Claude Code sessions run in different terminal tabs, you cannot tell without looking which one is blocked on a permission prompt, which one just asked you a question, which one keeps failing, and which one is quietly doing something dangerous such as dropping a database table. The attention manager is a terminal UI (`attention`) that watches all of your sessions, answers two questions in real time, and jumps you to the terminal of the session you pick:

1. **Which session needs me right now?** (attention priority)
2. **Which session should I keep an eye on?** (task severity)

Everything runs on your machine. Nothing is sent to a cloud service.

## The big picture

```
 Claude Code session A ─┐
 Claude Code session B ─┼─ hooks ─▶ hook forwarder ─▶ receiver (127.0.0.1:4318)
 Claude Code session C ─┘   (adds terminal identity)       │
                                                            │ state machine · risk rules
                                                            │ SQLite · local model (Ollama)
                                                            ▼
              your terminals ◀── focus ── attention TUI ◀── live stream
```

Four pieces cooperate:

| Piece | What it is | What it does |
| --- | --- | --- |
| **Hooks** | Entries in `~/.claude/settings.json` installed by `attention setup` (or `attention hooks install`) | Make every Claude Code session call a tiny forwarder whenever something notable happens; the forwarder also notes which terminal, tmux pane or window the session runs in |
| **Receiver** | A small Node.js service, started on demand by `attention` | Accepts those events, works out each session's state, stores it, and pushes changes to the UI |
| **Local model** | Ollama running a small model such as `qwen3:1.7b` | Reads the few ambiguous events and rates how risky a task is |
| **Terminal UI** | `attention`, a full-screen terminal app | Shows every session, ranked, with reasons, updates live, and focuses a session's terminal when you press Enter |

## Step 1: Claude Code tells us what is happening

Claude Code has a hook system: at well-defined moments it runs a command you configure and passes a JSON description of the moment on standard input. The attention manager subscribes to eleven of those moments:

| Moment | Hook event | What it tells us |
| --- | --- | --- |
| A session starts or resumes | `SessionStart` | A new row may be needed |
| You submit a prompt | `UserPromptSubmit` | The agent is working; what the task is |
| The agent is about to run a tool | `PreToolUse` | Still working; what it is about to run |
| A tool finished or failed | `PostToolUse`, `PostToolUseFailure` | Progress, or an error to consider |
| A tool needs your approval | `PermissionRequest` | The session is blocked on you |
| Claude Code shows a notification | `Notification` | Permission prompts, idle prompts, dialogs |
| The agent finished its turn | `Stop` | Done for now; what it said last |
| A subagent finished, context was compacted | `SubagentStop`, `PreCompact` | Activity only |
| The session ends | `SessionEnd` | The row can be retired |

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
| Ended | The session exited: `SessionEnd` arrived, or the receiver saw that the session's Claude process is gone (for example after exiting right after `/clear`, closing the terminal tab, or a crash, when Claude sends no `SessionEnd`) |

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

Its answer is a strict JSON object that is validated before use. It can change a label, a reason and a confidence. It can never change a session's status, lower a rule-based priority, run a command, or approve anything. If it is slow, missing or wrong, the rule-based state stays and the UI says so.

## Step 4: The terminal UI shows it

Run `attention`. It lists every session as a row, ordered so the most important is on top:

1. active sessions before ended ones,
2. higher attention priority first,
3. within the same priority, higher task severity first,
4. fresh before stale,
5. most recent first.

The list spans the full width under a column header. Each row shows a status glyph, the priority, the project name, the status, how long ago the last event arrived, the terminal it runs in (100+ columns), a risk badge for medium or higher task severity, and the reason (or the last event when nothing needs you). The task summary lives only in the detail. When the terminal is tall enough the selected session's details sit below the list (reason and evidence, task and risk, recent actions, recent events, where it runs); on a short one `d` drills into them.

The header shows the connection, the model, how many sessions need attention and how many are high-risk. When a session newly needs you, errors, or starts critical-risk work, its row is highlighted, the header flashes, a status line says why, and the terminal bell rings (toggle with `b`). Filters (`/` label, `1`-`5` priority, `e` ended) and sort (`s`) are one key away; `?` lists them all.

### Jumping to the session

Press Enter (or `f`) on a row and the UI switches to that session's terminal: the right tmux pane or screen window, the kitty or WezTerm tab, the iTerm2 or Terminal.app tab, or the X11 window (with `xdotool` or `wmctrl`), and on sway or Hyprland the right window. When none of those is possible (for example a plain terminal on GNOME or KDE Wayland, which offer no way for an app to focus another window), the status line says so and prints the tty, pid, directory and a command you can copy. Either way the UI also rings the bell on the session's tty, which marks its tab in VS Code, GNOME Terminal and most tabbed terminals and sets the window's urgency hint on X11, because raising a window cannot select a tab inside it. `attention focus <label>` does the same from a script.

### Honest about uncertainty

- A session that has been silent for longer than the staleness threshold (ten minutes by default) is dimmed and marked stale instead of pretending it is still working.
- When the UI loses the receiver, a banner says so with a retry countdown and the list keeps its last known state until the stream reconnects.
- When the model is unreachable or not installed, a banner says classification is rule-based only.
- Observed facts and model verdicts are labelled differently everywhere.

## What it deliberately does not do

- It never approves permissions or runs commands in your sessions, and it only switches terminals when you ask it to.
- It never sends prompts, code or events off your machine.
- It never stores tool outputs, file contents, transcripts or full paths. Task context can be turned off entirely with `CAPTURE_TASK_CONTEXT=0`.
- It never blocks Claude Code: a dead receiver costs each hook at most two seconds and is otherwise invisible.

## A typical session, end to end

1. You install it with `npm i -g attention-manager` and run `attention`. Setup asks three questions (hooks, local AI, terminal focus test) and opens the UI, which is empty with instructions.
2. You start Claude Code in a tmux pane and type "Write a migration that drops the legacy_users table". A row appears: **Working**, **⚠ critical** (keyword "drops the legacy_users table"), task line in the detail. A moment later the model agrees and the detail says "AI · 85%".
3. The agent asks to run `psql`. The row becomes **Needs attention / CRITICAL** with the reason "Waiting for permission to run Bash (critical-risk: Matched "DROP TABLE")", jumps to the top, flashes and rings the bell.
4. You press Enter. The UI selects that tmux pane; you decide there. The tool runs or is denied; the row returns to **Working**.
5. The agent finishes with "Should I also remove the backup table?". The row shows **Turn complete / Medium**, "appears to be asking a question", then the model confirms it is a question for you.
6. You close the session. The row moves out of view (press `e` to show ended sessions) and is purged after seven days.
