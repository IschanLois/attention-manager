# Worklog: scripted end-to-end demo

Tracking number: none (the project opted out of Jira/Linear ids).

## Purpose

Showing the tool meant starting several Claude Code sessions by hand and steering each one into an interesting state. `scripts/demo.sh` does that in one command: it opens the TUI and real Claude sessions in separate terminals, each prompted to land in a different attention state, so the ranking, risk flag and Enter-to-focus can be shown right away.

## Changes

- `scripts/demo.sh` (new):
  - Scenarios, each in `${ATTENTION_DEMO_DIR:-/tmp/attention-demo}/<scenario>` so the TUI label is the scenario name:
    - `needs-approval`: file write in `default` permission mode.
    - `risky-cleanup`: `rm -rf build` on a generated build folder.
    - `long-task`: `sleep 45`, pre-allowed with `--allowedTools`.
    - `question`: ends its turn with a question.
    - `quick-done`: one-word answer.
  - Opens windows with gnome-terminal, konsole, kitty, wezterm, `x-terminal-emulator` or Terminal.app. `--tmux` puts everything in one tmux session.
  - `--no-tui`, `--only a,b` and `--clean` options. `ATTENTION_DEMO_MODEL` passes `--model`.
  - Checks that `claude` is on PATH, that `attention` is built and that the hooks are installed before opening anything.
  - The spawned terminal re-runs the script with `--session <name>`, so no command line is quoted through a terminal emulator.
- `.claude/commands/demo.md`: uses the script instead of the manual steps.
- `README.md`: Demo subsection under Development.

## Update: lead with the local AI

The first scenarios leaned on keyword rules (`rm -rf`), which undersold the local model. The scenario set is now:

- `soft-question`, `hidden-risk`, `benign-failure`: worded so `assessRisk` returns nothing, so the TUI verdicts and reasons come from the model. Checked with `assessRisk` on all three prompts: no hits.
- `needs-approval`, `risky-cleanup`, `quick-done` kept; `long-task` and `question` removed (`soft-question` supersedes `question`).
- `hidden-risk` seeds `customers.csv`; `benign-failure` pre-allows `cat`.
- The script warns when `attention doctor` does not report the local model as available.
- README, `/demo` command and the watch-list text updated.

Model-dependent outcomes (what the AI ranks each scenario) are not asserted; judge them in the manual run. The AI can raise a keyword-free task by one level at most, so `hidden-risk` is expected to show medium, not critical.

## Decisions

- **Separate windows by default.** GNOME Terminal serves them all from one process, which exercises the window probe from `focus-shared-terminal-window`.
- **Nothing is approved automatically.** The approval and `rm -rf` scenarios stay pending until the presenter answers. `rm -rf` only targets the generated folder.
- **`rm` always asks in `risky-cleanup`.** The session gets `--settings` with an `ask` rule for `Bash(rm:*)`, so an auto-mode classifier or a broad allow rule in the presenter's own config cannot run the deletion silently. Manual check: the permission prompt appears before `build` is removed.
- **The TUI starts first, then a 2 s wait.** Sessions that start before the receiver listens are not recorded.
- **Folder trust is left to the user.** Hooks do not fire until a new folder is trusted. Writing `~/.claude.json` to pre-accept trust would change the user's Claude config. Trust is stored per path and the folders keep their paths, so the prompt only appears on the first run.

## Test plan

No automated tests: the script adds no business logic to the CLI.

Manual:
- `bash -n scripts/demo.sh`. `--only bogus` exits 1 with "unknown scenario". An unknown flag exits 2.
- Done: `scripts/demo.sh --no-tui --only quick-done` with a receiver running opened a GNOME Terminal window. `attention list` showed `quick-done · Turn complete · LOW`.
- To do: full run `scripts/demo.sh`. Check the six rows and that the three AI scenarios show AI verdicts and their states, and press Enter on each row with its window minimised.
- To do: `scripts/demo.sh --tmux` where tmux is installed (it is not on the development machine).
