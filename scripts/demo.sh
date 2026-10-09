#!/usr/bin/env bash
# Opens the attention TUI and several real Claude Code sessions, each steered into a
# different state, so the TUI can be watched ranking them and Enter can jump to each one.
set -euo pipefail

SELF="$(readlink -f "${BASH_SOURCE[0]}")"
DEMO_DIR="${ATTENTION_DEMO_DIR:-${TMPDIR:-/tmp}/attention-demo}"
MODEL="${ATTENTION_DEMO_MODEL:-}"
SCENARIOS=(needs-approval risky-cleanup long-task question quick-done)

usage() {
  cat <<EOF
Usage: scripts/demo.sh [--tmux] [--no-tui] [--only a,b] [--clean]

Opens the attention TUI and one Claude Code session per scenario, each in its own
terminal window (or tmux window with --tmux). Every session runs in its own folder under
$DEMO_DIR, so its label in the TUI is the scenario name.

Scenarios:
  needs-approval  asks to write a file and waits on the permission prompt
  risky-cleanup   asks to run rm -rf on its build folder (deny it to keep it)
  long-task       runs a 45 s command with no prompt, then finishes
  question        ends its turn with a question for you
  quick-done      answers in one word and goes idle

Options:
  --tmux      use one tmux session "attention-demo" instead of desktop windows
  --no-tui    do not open the TUI (it is already running)
  --only      comma-separated subset of scenarios
  --clean     remove $DEMO_DIR and exit

Environment:
  ATTENTION_DEMO_DIR    where the scenario folders go (default $DEMO_DIR)
  ATTENTION_DEMO_MODEL  model passed to claude --model (default: your configured model)

Every session is a real Claude Code session and uses your Claude plan or API credits.
Nothing is approved for you: answer the prompts in the session windows. On the first run
each window asks whether to trust its folder; a session only reaches the TUI once trusted.
EOF
}

die() { echo "demo: $*" >&2; exit 1; }

prompt_for() {
  case "$1" in
    needs-approval) echo "Create a file named notes.txt in this folder containing one line: 'attention demo'. Do not do anything else." ;;
    risky-cleanup) echo "This folder is running out of space. Delete the build directory by running exactly: rm -rf build" ;;
    long-task) echo "Run the shell command 'sleep 45 && echo finished' and then reply with only the word done." ;;
    question) echo "I want a hello-world program. Before writing anything, ask me whether I want Python or Go, then stop and wait for my answer." ;;
    quick-done) echo "Reply with exactly the word ready and nothing else." ;;
    *) die "unknown scenario: $1" ;;
  esac
}

# Runs inside the spawned terminal: starts claude in the scenario folder and keeps the
# window open after claude exits so the result stays readable.
run_session() {
  local name="$1"
  cd "$DEMO_DIR/$name"
  local args=(--permission-mode default -n "demo: $name")
  [[ -n "$MODEL" ]] && args+=(--model "$MODEL")
  [[ "$name" == "long-task" ]] && args+=(--allowedTools "Bash(sleep:*)" "Bash(echo:*)")
  printf '\033]2;demo: %s\007' "$name"
  claude "${args[@]}" "$(prompt_for "$name")" || true
  echo
  echo "[$name] claude exited. Press Enter to close."
  read -r _
}

prepare_folders() {
  local name
  for name in "$@"; do
    rm -rf "${DEMO_DIR:?}/$name"
    mkdir -p "$DEMO_DIR/$name"
  done
  if [[ -d "$DEMO_DIR/risky-cleanup" ]]; then
    mkdir -p "$DEMO_DIR/risky-cleanup/build/assets"
    head -c 65536 /dev/urandom >"$DEMO_DIR/risky-cleanup/build/bundle.js"
    echo "demo artefact" >"$DEMO_DIR/risky-cleanup/build/assets/readme.txt"
  fi
}

open_window() {
  local title="$1"; shift
  if command -v gnome-terminal >/dev/null; then
    gnome-terminal --window --title "$title" -- "$@"
  elif command -v konsole >/dev/null; then
    konsole --new-tab -p tabtitle="$title" -e "$@" &
  elif command -v kitty >/dev/null; then
    kitty --title "$title" "$@" &
  elif command -v wezterm >/dev/null; then
    wezterm start -- "$@" &
  elif command -v x-terminal-emulator >/dev/null; then
    x-terminal-emulator -T "$title" -e "$@" &
  elif [[ "$(uname)" == "Darwin" ]]; then
    osascript -e "tell application \"Terminal\" to do script \"$(printf '%q ' "$@")\"" >/dev/null
  else
    die "no supported terminal found; rerun with --tmux"
  fi
}

open_tmux() {
  local first=1 title
  tmux kill-session -t attention-demo 2>/dev/null || true
  for title in "$@"; do
    local cmd
    if [[ "$title" == "attention" ]]; then cmd="$(printf '%q' "$ATTENTION")"; else cmd="$(printf '%q ' "$SELF" --session "$title")"; fi
    if (( first )); then
      tmux new-session -d -s attention-demo -n "$title" "$cmd"
      first=0
    else
      tmux new-window -t attention-demo -n "$title" "$cmd"
    fi
  done
  tmux select-window -t "attention-demo:$1"
  echo "Attach with: tmux attach -t attention-demo"
}

main() {
  local use_tmux=0 with_tui=1 only=""
  while (( $# )); do
    case "$1" in
      --session) run_session "$2"; exit 0 ;;
      --tmux) use_tmux=1 ;;
      --no-tui) with_tui=0 ;;
      --only) only="$2"; shift ;;
      --clean) rm -rf "${DEMO_DIR:?}"; echo "Removed $DEMO_DIR"; exit 0 ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; exit 2 ;;
    esac
    shift
  done

  command -v claude >/dev/null || die "claude is not on PATH"
  ATTENTION="$(command -v attention || true)"
  [[ -n "$ATTENTION" ]] || ATTENTION="$(dirname "$SELF")/../dist/cli/main.js"
  [[ -x "$ATTENTION" ]] || die "attention is not built; run pnpm build"
  "$ATTENTION" hooks status | grep -q "Status: *installed" || die "hooks are not installed; run: attention setup"

  local selected=("${SCENARIOS[@]}")
  if [[ -n "$only" ]]; then
    IFS=, read -r -a selected <<<"$only"
    local name
    for name in "${selected[@]}"; do prompt_for "$name" >/dev/null; done
  fi

  prepare_folders "${selected[@]}"

  if (( use_tmux )); then
    command -v tmux >/dev/null || die "tmux is not installed"
    if (( with_tui )); then open_tmux attention "${selected[@]}"; else open_tmux "${selected[@]}"; fi
    return
  fi

  if (( with_tui )); then
    open_window "attention" "$ATTENTION"
    # The TUI starts the receiver; sessions that start before it is listening are missed.
    sleep 2
  fi
  local name
  for name in "${selected[@]}"; do
    open_window "demo: $name" "$SELF" --session "$name"
    sleep 0.5
  done

  cat <<EOF
Opened ${#selected[@]} Claude session(s) in $DEMO_DIR.
First run only: accept the folder-trust prompt in each window.
What to watch in the TUI:
  - needs-approval and risky-cleanup jump to the top as needing attention; risky-cleanup is flagged as risky.
  - long-task shows as working for ~45 s, then drops to turn complete.
  - question waits for your answer; quick-done shows turn complete at low priority.
  - Select a row and press Enter: the session's own window comes forward, even when minimised.
Clean up with: scripts/demo.sh --clean
EOF
}

main "$@"
