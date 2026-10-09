# Prompt: convert the dashboard to an npm-distributed CLI

Hand this prompt to a coding agent working in this repo.

## Context from the codebase analysis

- Reusable as-is: `src/core/*` (normalizer, state machine, risk rules, classifier, SQLite store) and `src/receiver/*` (HTTP ingest, SSE, pipeline).
- Replaced: the Next.js dashboard (`src/app`, `src/components`, `src/lib/hooks`), the only part needing `next`, `react` and `tailwind` at runtime.
- Missing for terminal focus: hook payloads carry only `session_id` and `cwd`, so `claude-hook.sh` must capture terminal identity and the schema and store must carry it.
- Not npm-ready: the hook installer writes an absolute `scripts/claude-hook.sh` path and `data/` is project-relative; both break for a global install.

## Prompt

```
You are working in the "Claude Code Attention Manager" repo (Node 24, TypeScript with
type stripping, pnpm). Read AGENTS.md, docs/technical-implementation.md,
docs/how-it-works.md and docs/worklogs/*.md first. Then convert the Next.js web
dashboard into an installable terminal CLI/TUI, publishable to npm.

## Goal
`npm i -g <name>` then `<name>` (suggested binary: `attention`; the package name is
configurable and must be easy to change in one place) opens a live terminal UI of all
Claude Code sessions needing attention. Selecting a session jumps the user to the
terminal window/tab/pane running that session.

## Target platforms
macOS and Linux only. Windows is out of scope: do not add Windows adapters, paths or
tests, and have the CLI exit with a clear "unsupported platform" message there.
Support Linux under both X11 and Wayland sessions, and macOS (Intel and Apple Silicon).

## Keep (do not rewrite)
- src/core/** (normalize, state machine, risk, classifier, store, schemas) and
  src/receiver/** (HTTP ingest, SSE, pipeline). Behavior and existing tests must keep passing.
- The hook-forwarding model: Claude Code hooks -> local receiver -> SQLite -> UI.

## Remove / replace
- Delete src/app, src/components, src/lib/{hooks,filters,sort,format,receiver,types}.ts's
  web-only parts, next.config.ts, tailwind/postcss/next/react deps, and their tests
  (dashboard-*.test.*). Port the logic worth keeping (sorting, filters, relative-time
  formatting, announcement of transitions) into framework-free modules under src/cli/
  with their tests migrated.
- The TUI reads data by connecting to the receiver's existing /api/sessions,
  /api/sessions/:id, /api/health and /api/stream (SSE). Do not add a new data path.

## CLI surface (use a small arg parser, e.g. commander or citty; keep deps minimal)
- `attention`            start the TUI (ensures the receiver is running, see below)
- `attention setup`      interactive first-run configuration (re-runnable)
- `attention doctor`     port of scripts/doctor.ts: receiver, sqlite, model, hooks, terminal detection
- `attention hooks install|uninstall|status`   port of scripts/setup-hooks.ts
- `attention receiver`   run the receiver in the foreground (headless / debugging)
- `attention list [--json] [--status ..] [--min-priority ..]`   non-interactive snapshot for scripting
- `attention focus <sessionId|label>`   jump to a session's terminal without opening the TUI
- `attention --version`, `--help`
Exit codes must be meaningful (0 ok, 1 error, 2 misconfiguration); `--json` output must be stable.

## Receiver lifecycle
`attention` should reuse a running receiver (probe /api/health) or spawn one as a
detached child in the same package (no `pnpm`, no `.env` file, no cwd assumptions),
and stop only what it started. A second `attention` instance must attach to the same
receiver. Handle port-in-use with a clear message, not a stack trace.

## Terminal focus (the key new capability)
Hook payloads do not identify the terminal, so capture it at hook time:
1. Extend the hook forwarder (scripts/claude-hook.sh and the .mjs fallback; consider
   replacing the shell script with a tiny Node entry `attention hook` for portability,
   keeping the fast, always-exit-0, token-via-header-file guarantees) to attach a
   `terminal` object collected from the environment of the Claude process:
   TERM_PROGRAM, TMUX + TMUX_PANE, STY (screen), WEZTERM_PANE, KITTY_WINDOW_ID +
   KITTY_LISTEN_ON, ITERM_SESSION_ID, ALACRITTY_SOCKET, TERM_SESSION_ID,
   WINDOWID (X11), the controlling TTY path, and the PID of the Claude process
   (walk up PPID to find it). Treat all values as untrusted: validate with zod, bound
   lengths, strip control chars, never allow shell metacharacters through to a command.
2. Extend the zod schemas, SessionView, the SQLite store (idempotent ALTER TABLE
   migration, as the existing columns do) so the latest terminal info is stored per
   session and updates when the same session reappears from another pane.
3. Implement a `TerminalFocuser` port in src/cli/focus/ with one adapter per backend,
   chosen by detected environment, with the most specific winning (tmux inside
   wezterm -> select the tmux pane AND focus the host terminal):
   - tmux: `tmux select-window` + `select-pane` (+ `switch-client` if attached elsewhere)
   - screen, kitty (`kitten @ focus-window`), wezterm (`wezterm cli activate-pane`),
     iTerm2 / Terminal.app (AppleScript via osascript, matched on tty/session id; macOS
     only, and note the Automation permission prompt in setup/doctor)
   - Linux X11 generic: `xdotool windowactivate`/`wmctrl` using WINDOWID or a PID->window lookup
   - Linux Wayland: only compositor- or terminal-specific routes (e.g. kitty/wezterm remote
     control, tmux); optionally `swaymsg`/`hyprctl` when detected
   - Fallback: print the tty/pid/cwd and a copyable command; never fail silently.
   All adapters call binaries with execFile and an args array (never a shell string),
   have a short timeout, and return a typed result {focused | unsupported | failed(reason)}
   that the UI shows as a status line message. Wayland has no generic focus API:
   say so honestly in `doctor` and in the fallback message.
4. `doctor` reports which backend was detected for the current shell and which
   sessions are focusable.

## UI/UX (terminal)
Use a TUI library (Ink + React is acceptable since the team knows React; justify the choice
in the worklog against blessed/terminal-kit/raw ANSI). Requirements:
- Layout: header (connection state, model health, counts), filter bar, session list
  ordered by the existing attention ordering, detail panel (task summary, risk hits,
  reason/evidence, recent actions, recent events) shown beside the list on wide
  terminals and as a drill-down on narrow ones; footer with context-sensitive key hints.
- Colour-coded status/priority/risk badges with a readable no-colour fallback
  (respect NO_COLOR, non-TTY, TERM=dumb, and `--no-color`); unicode glyphs with ASCII fallback.
- Keyboard: j/k and arrows, Enter or `f` = focus that session's terminal, `d` or Tab = detail,
  `/` = filter by label, `s` cycle sort, `e` toggle ended, `1-5` priority filters,
  `r` reconnect, `?` help overlay, `q`/Ctrl-C quit and restore the terminal cleanly
  (alt screen, cursor, raw mode) including on crashes and SIGTERM.
- Live updates over SSE with reconnect backoff and a visible "reconnecting / offline" state;
  ticking relative times without re-rendering the whole screen; handle terminal resize.
- Attention cues: when a session newly enters needs_attention/error or critical risk,
  highlight the row, flash the header, and ring the terminal bell (toggleable); optional
  desktop notification is out of scope.
- Empty state that explains how to connect (`attention hooks install`) and a degraded
  banner when the model is unavailable (rule-based only).
- Keep render logic separate from state so it is testable without a TTY.

## First-run configuration (`attention setup`, auto-run when no config exists)
Ask ONLY what is necessary for the demo, everything else uses defaults:
1. Install the Claude Code hooks into ~/.claude/settings.json? (show the diff summary; keep
   the existing backup/merge guarantees)
2. Use local AI classification? If yes, Ollama URL (default http://127.0.0.1:11434) and model
   (default qwen3:1.7b); verify reachability and whether the model is installed and, if
   missing, print the exact `ollama pull` command rather than pulling silently.
3. Terminal integration: confirm the auto-detected terminal/multiplexer and test-focus it.
Do NOT prompt for ports, timeouts, retention, rate limits, body size, etc. Keep those as
defaults, overridable via env vars or the config file. Generate the ingest token silently.
Support `--yes` / non-interactive mode (use defaults, no prompts, for CI and scripts) and
re-running to change answers. Use a prompt library (e.g. @clack/prompts) for good UX.

## Packaging for npm
- State directory instead of ./data: config, ingest-token, ingest-header, attention.db and
  logs under XDG paths (~/.config/<name>, ~/.local/state/<name>; platform equivalents on
  macOS: ~/Library/Application Support/<name> and ~/Library/Logs/<name>), 0600/0700 permissions. Config file is JSON validated by zod.
- Hook command written to settings.json must reference the installed package (resolve via
  the package's bin / an absolute path computed at install time, and re-installable after
  upgrades; `hooks status` detects a stale path).
- package.json: name, version, `bin`, `files` whitelist (only dist/ or src/ needed at
  runtime, no tests/docs/fixtures), `engines.node >=24`, `type: module`, license, repository,
  keywords, `publishConfig.access`, `prepack`/`prepublishOnly` running verify. Node's
  type-stripping does not run on files inside node_modules, so add a build step (tsc or
  tsdown/esbuild) that emits plain JS to dist/ and point `bin` at it with a shebang. Keep
  `node:sqlite` (no native deps) and document the experimental-warning suppression done
  inside the bin entry, not via flags the user must pass.
- Mark the package unpublished-but-ready: do NOT run `npm publish`; verify with
  `npm pack --dry-run` and by installing the tarball into a temp prefix and running
  `attention --version`, `attention doctor`, `attention list --json`.
- README rewritten for the CLI (install, setup, usage, key bindings, supported terminals,
  uninstall incl. `hooks uninstall`, data locations). Update docs/ accordingly.
- Remove next from `.env.example`; document env vars that remain.

## Process rules (from the repo's CLAUDE.md / memory)
- Create a new branch first (no tracking number for this project; use e.g. feat/cli).
- TDD: write the failing tests first, then implement; no pause between them.
- Tests cover business logic only, no logging/side-effect assertions: terminal detection
  from env fixtures, focuser selection and argument construction (inject an exec fake),
  schema/store migration, filter/sort/format ports, setup flow decisions with a prompt
  fake, TUI state reducer, CLI arg handling. Add a smoke test spawning the built binary.
- Conventional commit prefixes, small commits, never commit .env or the token.
- Add/update docs/worklogs/cli.md with purpose, changes, test plan (automated + manual per
  terminal), decisions (TUI library, bundler), and known limits (Wayland, no Windows support).
- Finish by running the repo's verify workflow (lint, typecheck, tests, build, pack dry-run)
  and report results honestly, including anything unverified (e.g. terminals you could not test).

## Acceptance
0. Works on macOS and Linux; adapter selection and path resolution are covered by tests
   using injected platform/env values so both can be verified from either OS.
1. Fresh machine: `npm i -g ./attention-*.tgz && attention` walks through setup in under a
   minute with at most three questions, then shows the live UI.
2. With two Claude sessions in two tmux panes (and, where available, two terminal windows),
   Enter on a session focuses the right one; unsupported setups show a clear fallback.
3. Killing the receiver or Ollama degrades visibly and recovers without restarting the TUI.
4. Quitting always restores the terminal; no orphaned receiver unless started with `--keep-running`.
5. All existing core/receiver tests still pass; no Next/React-DOM/Tailwind remain in
   dependencies (react only if Ink is chosen).
```
