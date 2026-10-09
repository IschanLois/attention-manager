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

## Decisions

- **Separate windows by default.** GNOME Terminal serves them all from one process, which exercises the window probe from `focus-shared-terminal-window`.
- **Nothing is approved automatically.** The approval and `rm -rf` scenarios stay pending until the presenter answers. `rm -rf` only targets the generated folder.
- **The TUI starts first, then a 2 s wait.** Sessions that start before the receiver listens are not recorded.
- **Folder trust is left to the user.** Hooks do not fire until a new folder is trusted. Writing `~/.claude.json` to pre-accept trust would change the user's Claude config. Trust is stored per path and the folders keep their paths, so the prompt only appears on the first run.

## Test plan

No automated tests: the script adds no business logic to the CLI.

Manual:
- `bash -n scripts/demo.sh`. `--only bogus` exits 1 with "unknown scenario". An unknown flag exits 2.
- Done: `scripts/demo.sh --no-tui --only quick-done` with a receiver running opened a GNOME Terminal window. `attention list` showed `quick-done · Turn complete · LOW`.
- To do: full run `scripts/demo.sh`. Check the five rows and their states, and press Enter on each row with its window minimised.
- To do: `scripts/demo.sh --tmux` where tmux is installed (it is not on the development machine).
