Run the full verification workflow for this repository and report results honestly:

1. `pnpm test` (Vitest unit and receiver integration tests)
2. `pnpm typecheck`
3. `pnpm lint`
4. `pnpm build`
5. `pnpm doctor` (only meaningful when the receiver is running; report its output either way)

If any step fails, show the failing output, fix the cause if it is in this repository, and rerun that step. Finish with a short table of step and outcome.
