Verify the npm package the way a user installs it, without touching the real home directory or publishing anything:

1. Pick a scratch directory `S` (the session scratchpad, never the repo) and an unused port, for example `RECEIVER_PORT=48319`.
2. `npm pack --pack-destination "$S/pack"` (runs `prepack`, which builds `dist/`).
3. `npm i -g --prefix "$S/prefix" "$S"/pack/attention-manager-*.tgz`
4. With `HOME="$S/home" PATH="$S/prefix/bin:$PATH" RECEIVER_PORT=<port>` run:
   - `attention --version` (expect the package version, exit 0, nothing on stderr)
   - `attention doctor` (expect exit 2 on a fresh home: no hooks, no token)
   - `attention list --json` (expect exit 1: receiver not running)
   - `attention setup --yes`, then `attention hooks status` (expect `installed`, hook path inside `$S/prefix/lib/node_modules/...`)
   - start `attention receiver &`, pipe a sample hook payload into `node "$S"/prefix/lib/node_modules/attention-manager/dist/hook/main.js`, and check `attention list --json` shows it
5. Stop any receiver you started (by its pid, not with a pattern that also matches your own shell) and report each step's result.

Never run `npm publish`.
