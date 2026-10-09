Run the full verification workflow for this repository and report results honestly:

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm build` (tsc to `dist/`; the smoke test in the next step runs the built binary)
4. `pnpm test` (unit, receiver integration, TUI render and built-binary smoke tests; no Ollama needed)
5. `npm pack --dry-run` and check the file list only contains `dist/`, `README.md`, `LICENSE` and `package.json`
6. `node dist/cli/main.js doctor` (report its output either way; a missing receiver is only a warning)

`pnpm verify` runs steps 1 to 5 in order. If any step fails, show the failing output, fix the cause if it is in this repository, and rerun that step. Finish with a short table of step and outcome, and list anything you could not verify (for example terminals or platforms not available on this machine).
