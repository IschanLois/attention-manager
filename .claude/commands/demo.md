Prepare and run the end-to-end demo of the attention manager:

1. Check `pnpm doctor`; if hooks are not installed, run `pnpm hooks:install` and tell the user to restart any open Claude Code sessions.
2. Start `pnpm dev` in the background and confirm http://127.0.0.1:4318/api/health and http://localhost:3000 respond.
3. Explain to the user how to trigger an observable interruption: in a separate terminal start `claude --permission-mode default` and ask it to run a command that needs approval (for example `touch demo.txt`). The session card should switch to "Needs attention / High" within a second.
4. Show how to stop everything: Ctrl+C on `pnpm dev`, and `pnpm hooks:uninstall` for teardown.

Never approve permissions on the user's behalf and never modify ~/.claude/settings.json without saying so first.
