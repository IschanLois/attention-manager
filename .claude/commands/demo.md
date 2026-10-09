Prepare and run the end-to-end demo of the attention CLI:

1. Build and link the CLI: `pnpm build`, then either `npm i -g .` or use `node dist/cli/main.js` in place of `attention` below.
2. Run `attention doctor`. If hooks are missing or stale, run `attention setup` (or `attention hooks install`) and tell the user to restart any open Claude Code sessions.
3. Ask the user to run `attention` in a terminal of their own (it is a full-screen TUI; do not try to drive it from this session). It starts the receiver itself.
4. Explain how to trigger an observable interruption: in a separate terminal or tmux pane start `claude --permission-mode default` and ask it to run a command that needs approval (for example `touch demo.txt`). The row should switch to "Needs attention / HIGH" within a second, flash and ring the bell; Enter focuses that pane.
5. Show how to stop everything: `q` in the TUI (the receiver it started exits a few seconds later), and `attention hooks uninstall` for teardown.

Never approve permissions on the user's behalf and never modify ~/.claude/settings.json without saying so first.
