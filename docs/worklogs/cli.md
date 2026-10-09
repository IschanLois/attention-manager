# Worklog: npm-distributed CLI and terminal UI

**Tracking number:** none (project opted out of Jira/Linear ids)
**Branch:** `feat/cli` (from `feat/task-severity`)
**Started:** 2026-10-09
**Brief:** `docs/prompts/cli-conversion.md`

## Purpose

Replace the Next.js web dashboard with a terminal UI that installs from npm (`npm i -g attention-manager`, binary `attention`), configures itself in three questions or fewer, and jumps to the terminal, tmux pane or window running a session when you press Enter. The hook-forwarding model stays the same (Claude Code hooks → local receiver → SQLite → UI), and `src/core` and `src/receiver` were kept, with small additive changes.

## Decisions

1. **TUI library: Ink 7 + React 19.** The team already knows React; the pure parts (sorting, filters, announcements, the old stream reducer) ported directly into a reducer; `ink-testing-library` renders frames without a TTY; Ink 7 handles alternate screen, raw mode, resize (`useWindowSize`) and incremental rendering. The alternatives lost: blessed is unmaintained and its widget model is imperative; terminal-kit is imperative and hard to render in tests; raw ANSI means writing layout, wrapping, diffing, resize and input decoding by hand. Ink 7.1.1 was chosen over the six-day-old 8.0.0.
2. **Build: plain `tsc -p tsconfig.build.json` to `dist/`** with `rewriteRelativeImportExtensions`. Node type stripping does not run inside `node_modules`, so the package needs JS. `tsc` was already a dev dependency, handles `.tsx`, keeps the module layout (so `import.meta.url`-relative paths work the same in `src/` and `dist/`) and leaves runtime dependencies external. A bundler (tsdown, esbuild) would add a tool for no gain at this size.
3. **Argument parsing: `node:util` `parseArgs`** with a small dispatcher (`src/cli/args.ts`), so no dependency. Unknown commands, flags and stray arguments exit 2.
4. **Hook forwarder: a dependency-free Node entry (`dist/hook/main.js`)** replaces `scripts/claude-hook.sh` and its `.mjs` fallback. It keeps the guarantees (2 s timeout, always exit 0, no output, token read from a 0600 file and never in argv, payload minimisation formerly done by `jq`) and adds terminal identity. The settings command is `"<process.execPath>" "<abs dist/hook/main.js>"` so it needs no `PATH` and no shell features. `hooks status` flags hooks pointing elsewhere (a moved prefix, another Node version, the legacy shell script) as stale.
5. **Terminal identity is captured at hook time** from Claude's environment and process tree, validated by the receiver field by field against allow-list patterns, stored as a JSON column (idempotent `ALTER TABLE`), and replaced whenever an event carries a new one.
6. **Focus adapters** (`src/cli/focus/`): most specific first (multiplexer, then terminal remote control, then desktop window), all run, `focused` if any succeeded. Only `execFile` with argv arrays and a 1.5 s timeout; AppleScript gets identifiers via `on run argv`. Generic Wayland gets no fake support; `doctor`, `setup` and the fallback hint say so.
7. **Receiver lifecycle:** `attention` attaches to a running receiver (health probe with `app` name), otherwise spawns `attention receiver --exit-when-idle` detached. The spawned receiver exits 3 s after its last SSE client leaves (20 s startup grace), which covers quitting, crashing and several UIs without a pid file or reference counting. `--keep-running` spawns without the idle flag. Anything else answering on the port is a conflict (exit 2).
8. **State directories:** XDG on Linux, `~/Library/Application Support` and `~/Library/Logs` on macOS, explicit `XDG_*` honoured on macOS too, `ATTENTION_CONFIG_DIR`/`ATTENTION_STATE_DIR` overrides; 0700 directories, 0600 files. `config.json` is zod-validated.
9. **The receiver always has a token:** `attention receiver` creates one if missing instead of refusing to start, so `ATTENTION_ALLOW_NO_TOKEN` is no longer reachable from the CLI.
10. **`node:sqlite` ExperimentalWarning** is filtered by wrapping `process.emitWarning` in the bin entry before any module that imports `node:sqlite` is loaded (all commands are imported dynamically). Users never pass `--no-warnings`.
11. **Setup asks at most three questions** (hooks; local AI as one select with default / custom / off; a focus test when a route exists). A custom URL and model add two text prompts only when chosen. `--yes` keeps AI enabled (the degraded banner explains a missing Ollama) and skips the focus test.
12. **Package name** `attention-manager` (user's choice; it was unclaimed on npm on 2026-10-09), MIT license. The name and binary come only from `package.json`.
13. **Env template stays `env.example`.** The global convention asks for `.env.example`, but a local safety hook blocks any tool access to files matching `.env*`, so the rename was not possible from this session. The README links `env.example`.
14. **AGENTS.md** still carries the Next.js notice written by `next dev`; it is gitignored in this repo, so no committed change was needed. Delete the block locally once Next is gone from `node_modules`.
15. **Privacy:** focus needs the working directory, tty and process ids, so those are now stored per session; the README privacy section says so (it previously promised that full working directories are never stored).

## Changes

- `007212a` feat: XDG/macOS paths (`src/cli/paths.ts`), platform guard (`src/cli/platform.ts`), zod CLI config (`src/cli/config.ts`), `loadConfig` accepts injected defaults (env still wins).
- `2c3f3f1` feat: `src/core/terminal.ts` (schema and sanitiser), `src/hook/{collect,minimize,main}.ts`, `terminal` on `NormalizedEvent`/`Session`, reducer keeps the latest, store column and migration.
- `3926757` feat: `src/cli/hooks.ts` (quoted command, merge, replace legacy/stale, status, token files).
- `fd1d2b8` feat: focus adapters and planner (`src/cli/focus/*`), including a `wmctrl -lp` lookup when `xdotool` is missing.
- `9e869ac` refactor: sort/filters/format/labels/announcements moved to `src/cli/model/` (filters now parse CLI flags and a label query), Next app, components, shell forwarder and pnpm-only scripts deleted, next/react-dom/tailwind/eslint-config-next/happy-dom removed, `typescript-eslint` + `eslint-plugin-react-hooks`, `tsconfig.build.json`, package metadata, LICENSE.
- `8186abe` feat: `args.ts`, `sse.ts`, `lifecycle.ts`, `client.ts`, `context.ts`, `doctor.ts`, `help.ts`, `commands/{list,focus,hooks,receiver}.ts`; receiver health reports `app` and exposes `sseClients()`; `src/receiver/main.ts` replaced by `attention receiver`.
- `bfc9168` feat: Ink TUI (`src/cli/tui/*`), setup flow (`src/cli/setup.ts`, `commands/setup.ts`), `commands/tui.ts`, bin entry `src/cli/main.ts`, built-binary smoke test.
- `8e80890` fix: connecting state instead of an empty detail pane.
- fix: AI confidence was lost in the port. Rows now show `AI 72%` before the reason when the attention verdict came from the model (placed before the reason so narrow terminals do not truncate it), the detail shows `[AI · 85%]` or `[Observed]` next to the task-severity line as well as the reason, and `list --json` adds `reasonSource`, `reasonConfidence`, `taskSeveritySource` and `taskSeverityConfidence`.
- docs: README rewritten for the CLI, `docs/how-it-works.md` and `docs/technical-implementation.md` updated, `env.example` rewritten, `.claude/commands/{verify,demo,pack-smoke}.md`.

## Test plan

### Automated

`pnpm verify` = lint, typecheck, build, tests, `npm pack --dry-run`. New suites:

- `cli-paths`, `cli-config`, `cli-color`: path resolution for Linux/macOS/XDG/overrides from injected values, Windows rejection, config defaults/validation/round-trip, colour rules.
- `terminal-capture`, `terminal-session`, `hook-forwarder`: sanitiser (metacharacters, control characters, oversize), env fixtures (tmux in WezTerm on X11, kitty on Wayland, screen, iTerm2, Terminal.app, Alacritty), PPID walk, `/proc` and `ps` parsing, minimisation, normalize/reducer/store migration, the forwarder against a live receiver (token, unreachable receiver, malformed payload, wrong token).
- `cli-hooks`: command quoting, ours vs. foreign, install/replace/no-op, uninstall, status (installed, absent, partial, stale by path and by missing file), backup and atomic write, token files.
- `cli-focus`: adapter selection matrix for both OSes and X11/GNOME-Wayland/sway/Hyprland, exact argv per adapter via a fake exec, result combination, fallback and Wayland wording.
- `cli-args`, `cli-sse`, `cli-lifecycle`, `cli-commands`, `cli-doctor`, `cli-setup`: parsing and exit codes, SSE frames and backoff, attach/spawn/conflict/early exit/timeout, `list --json` shape and filters, `focus` matching and ambiguity, `hooks` command, doctor aggregation, every setup branch with a fake prompter.
- `cli-model`, `cli-sort` (migrated from the dashboard tests), `tui-state`, `tui-keys`, `tui-render`: reducer, key map, frames for wide/narrow/empty/connecting/degraded/offline/help/label query/no-colour, theme detection.
- `cli-smoke`: the built binary and hook in an isolated HOME (version, help, unknown command, hook → `list --json`, doctor exit 2, refusing a non-TTY UI).

Result on 2026-10-09 (Linux, Node 24.12): 304 tests pass; lint, typecheck and build clean.

### Manual

Done on this machine (Linux Mint/Cinnamon, X11, VS Code terminal, Ollama with qwen3:1.7b, no tmux/xdotool installed, temp `HOME` and a non-default port):

| Scenario | Result |
| --- | --- |
| `npm pack`, `npm i -g --prefix <tmp> ./attention-manager-0.1.0.tgz`, `attention --version` / `doctor` / `list --json` | 0.1.0; doctor exit 2 (no hooks, no token) with hints; list exit 1 "receiver is not running" |
| First run of the installed `attention` in a pty | three questions (Enter on each), hooks installed into the temp settings, model found, X11 focus test succeeded, UI opened |
| `hooks status` after install | `installed`, command points into the temp prefix's `lib/node_modules/attention-manager/dist/hook/main.js` |
| Hook → receiver → `list`/`list --json`/`doctor` | session shown as Needs attention / CRITICAL with terminal identity (tty, pid, ancestors, cwd, display); doctor all OK |
| `attention focus demo` | focused via X11 using the `wmctrl -lp` ancestry lookup; tmux step reported "not installed" |
| TUI keys `j`, `?`, any key, `q` | rendered list and detail side by side at 120 columns; exit 0; alternate screen left and cursor shown |
| Quit when the UI spawned the receiver | receiver logged "no UI attached" and exited 3 s after quit |
| `--keep-running` | receiver still running after quit |
| SIGTERM to the UI | UI exited, terminal restored, receiver idled out |
| Kill the receiver under a running UI, restart it | header went live → reconnecting → offline → live without restarting the UI |
| Ollama unreachable (`OLLAMA_URL` pointed at a closed port) | header "model down" and the "Local model unavailable … rule-based only" banner |
| A second receiver on the same port | "Port … is already in use" message, exit 2 |

Still to verify by hand (no access from this session):

| Terminal / environment | What to check |
| --- | --- |
| Two `claude` sessions in two tmux panes | Enter focuses the right pane; with the UI inside the same tmux server, `switch-client` moves the client |
| tmux inside WezTerm / kitty | pane selected and the host tab activated |
| GNU screen | `select <window>` switches the attached display |
| kitty with `allow_remote_control` | `kitten @ focus-window` |
| WezTerm | `wezterm cli activate-pane` |
| macOS iTerm2 and Terminal.app (Intel and Apple Silicon) | Automation prompt appears once; the right tab is selected; `~/Library` paths |
| Linux X11 with `xdotool` | `WINDOWID` and `search --pid` routes |
| sway, Hyprland | `swaymsg [pid=N] focus`, `hyprctl dispatch focuswindow pid:N` |
| GNOME / KDE Wayland | fallback hint with the Wayland explanation; `doctor` warns |
| A real Claude Code session after `attention setup` | events arrive through the installed hook; the Claude process (comm `claude`) is picked for tty and pid |

## Change: stacked layout and terminal highlight

**Purpose.** The side-by-side split (list 55% | detail 45%) truncated rows early. The list now spans the full width with the detail below it, and the freed width carries more columns. On tabbed terminals (VS Code, GNOME Terminal) focus can raise the window but not pick the tab, so Enter now also marks the session's terminal.

**Changes.**
- `Screen.tsx`: the list sits on top (up to 45% of the body, sized to the sessions), a divider, then the detail at full width. Below 14 body rows it is list only and `d` drills in. `WIDE_MIN_COLUMNS` is gone; the footer's "narrow" hints follow the stacked/drill-down choice.
- `components.tsx`: `SessionList` renders a column header and keeps its overflow line inside its height. `SessionRow` takes a shared `RowLayout`: label width sized to the longest visible label, and a **Terminal** column at 100+ columns (`terminalShort`: `tmux %2`, `kitty 4`, `vscode pts/3`, …). Rows no longer show the task summary (previously the fallback when there was no attention reason); the reason column shows the attention reason or the last event, and the task appears only in the detail below.
- `focus/highlight.ts` (new) `ringTty`: opens the tty `O_WRONLY | O_NOCTTY | O_NONBLOCK`, checks it is a character device owned by the current user, writes BEL. Injected through `FocusContext.ringTty` / `CliContext.ringTty`.
- `focus/select.ts` `focusSession`: after the adapters, rings the session's tty whatever the outcome; a successful ring sets `highlighted` on the result. A failed ring never changes the result kind.
- `commands/focus.ts` `describeFocusResult`: "…, rang the bell on pts/3", and for unsupported/failed it leads with "Rang the bell on pts/3 to mark its tab." Both the TUI status line and `attention focus` use it.

**Decisions.**
- A "project" column was dropped: the label already is the cwd basename.
- A separate task column (140+ columns) was tried and removed on review: with the detail stacked below, the task was shown twice.
- The bell is the highlight because every terminal understands it without per-terminal integration; VS Code needs `terminal.integrated.enableBell` (or the terminal bell accessibility signal) to show it.
- No extra row flash on Enter: the status line already acknowledges the press ("Focusing …" then the result).

**Tests.** `tui-render`: list above the detail, list-only on short terminals with the drill-down, column header and terminal column at 110 (not at 70), no task summary in any row at 110 or 160 (also when there is no attention reason), and no TASK header. `cli-focus`: the tty is rung after focus, on unsupported and on failed results, not without a tty, and a failed ring keeps `focused`; `describeFocusResult` names the tty.

**Manual.** Run `attention` with Claude sessions in other VS Code terminal tabs: full-width list with the header and Terminal column, the detail below it following the selection, list only after shrinking the height. Enter raises the window (wmctrl) and the session's tab shows the bell marker; the status line names the tty. `attention focus <label>` prints the same message.

## Known limitations

- **Wayland:** there is no generic window-focus API. Only tmux, screen, kitty, WezTerm, sway and Hyprland routes work there; GNOME and KDE get the manual hint.
- **No Windows support;** the CLI exits 2 with "unsupported platform".
- **X11 ancestry lookup** focuses the first window owned by the terminal emulator process, which can be the wrong window of a multi-window terminal (GNOME Terminal runs all windows in one server process). `WINDOWID`, when the terminal sets it, is exact.
- **Inside tmux,** host-terminal variables (`WINDOWID`, `KITTY_WINDOW_ID`, `WEZTERM_PANE`) come from the tmux server's environment and can be stale; the tmux step still selects the right pane.
- **WezTerm `activate-pane`** selects the pane but may not raise the GUI window on every platform; the X11 step covers that when available.
- **Sessions started before the hooks were reinstalled** have no terminal information until their next event.
- **The smoke test is skipped** when `dist/` has not been built; `pnpm verify` builds first.
- The macOS, iTerm2, Terminal.app, kitty, WezTerm, screen, tmux, sway and Hyprland adapters are covered by argument-level unit tests only; see the manual list above.
