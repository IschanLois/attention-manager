# Worklog: end sessions whose Claude process exited

Tracking number: none (the project opted out of Jira/Linear ids).

## Purpose

Sessions lingered in the list as "starting" even though no terminal was running them. They came from `/clear`: Claude Code ends the old session (`SessionEnd` reason `clear`) and starts a new id (`SessionStart` source `clear`). Exiting right afterwards sent no `SessionEnd` for the new id, so it stayed open indefinitely. The same thing happens when a tab is closed or Claude crashes. Ended sessions ignore every event except `session_start`, so the fix has to be sure before it ends one.

Observed on this machine: `85f8b23d` (pts/10) and `14da9960` (pts/11), each with a single `session_start (clear)` event, recorded Claude pids no longer running.

## Changes

- `src/core/terminal.ts`: `processName` (allow-list `^[A-Za-z0-9_.+-]{1,32}$`) added to the terminal schema.
- `src/hook/collect.ts`: `findClaudeProcess` returns the chosen process's command name; `collectTerminal` records it as `processName`.
- `src/receiver/liveness.ts` (new): `probeProcess(pid)` (`kill(pid, 0)`, plus `/proc/<pid>/comm` on Linux) and the pure `exitedSessionIds(sessions, probe, now, staleAfterMs)`.
- `src/receiver/server.ts`: `endExitedSessions()` runs at start and every `livenessIntervalMs` (default 15 s, `0` disables). Each exited session is ended by ingesting a synthetic `SessionEnd` with reason `process_exited`. `probeProcess` and `livenessIntervalMs` are injectable options.

## Decisions

- **Process liveness, not tty reuse.** "A new session started on the same tty" would also catch a nested `claude -p` run from a session's Bash tool. The process check catches closed tabs and crashes as well.
- **Only trust a pid recorded as Claude.** The hook falls back to the first ancestor with a terminal when no process is named `claude`. That can be a short-lived wrapper, so those sessions are never ended by liveness.
- **Older hooks** (no `processName`): ended only when the pid is gone *and* the session is stale (`STALE_AFTER_MS`, 10 min), so the sessions already stuck in existing databases get cleared.
- **Pid reuse**: on Linux an alive pid whose `comm` differs from the recorded name counts as exited. On macOS only a dead pid counts (no `/proc`, and no extra `ps` call every 15 s).
- **Synthetic `SessionEnd` through `ingest`**: the session detail shows "Session ended (process_exited)", and SSE clients update with no new broadcast path.

## Test plan

Automated:
- `tests/session-liveness.test.ts`: dead Claude pid ended, live kept; pid reused by another program ended; unreadable name kept; non-Claude pid never ended; older-hook sessions need dead + stale; ended sessions and sessions without a pid ignored.
- `tests/receiver.test.ts`: `endExitedSessions` ends only the exited session, stores the `process_exited` event and is idempotent; a session left open while the receiver was down is ended at startup.
- `tests/terminal-capture.test.ts`: `processName` captured from the process tree and sanitised.

Manual (done): a receiver on port 4399 from this branch against a copy of the real database ended `85f8b23d` and `14da9960` at startup ("ended sessions whose Claude process exited" `count: 2`) and left the two running sessions alone.

Manual (to do): start `claude`, run `/clear`, exit, and check the new session turns Ended within 15 s. Close a terminal tab running `claude` and check the same. Run a nested `claude -p` from inside a session and check the parent stays open.

## Follow-up: orphaned Claude after closing a VS Code terminal

Closing an integrated terminal tab left `claude` running (parent `init`, state `Tl`, pty `(deleted)`), so `kill(pid, 0)` still succeeded and the session never ended.

- `src/receiver/liveness.ts`: `probeProcess` reports `detached` when `/proc/<pid>/fd/0` points at a deleted file; `exitedSessionIds` treats a detached process like a gone one (older-hook sessions still also need to be stale). Linux only.
- Test: `tests/session-liveness.test.ts` ends a detached Claude process and keeps an attached one.
- Manual (done): the orphan `80853` from the closed VS Code tab matched the signature.
