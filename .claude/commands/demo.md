Prepare and run the end-to-end demo of the attention CLI:

1. Build the CLI with `pnpm build`. The global `attention` (or `node dist/cli/main.js`) runs the build.
2. Run `attention doctor`. If hooks are missing or stale, run `attention setup` (or `attention hooks install`) and tell the user to restart any open Claude Code sessions.
3. Tell the user to run `scripts/demo.sh` from a terminal of their own (`--tmux` on Wayland or without a desktop terminal, `--no-tui` if the TUI is already open, `--only a,b` for a subset). It opens the TUI and one real Claude session per scenario: needs-approval, risky-cleanup, long-task, question, quick-done. Mention that the sessions use their Claude plan or credits and that on the first run each window asks to trust its folder.
4. Explain what to watch: needs-approval and risky-cleanup rise to the top needing attention (risky-cleanup flagged as risky), long-task shows working and then turn complete, question waits for an answer, quick-done is low priority. Selecting a row and pressing Enter raises that session's own window, even when minimised.
5. Show how to stop everything: `q` in the TUI (the receiver it started exits a few seconds later), close the session windows, `scripts/demo.sh --clean` to remove the scenario folders and `attention hooks uninstall` for teardown.

Never approve permissions on the user's behalf and never modify ~/.claude/settings.json without saying so first.
