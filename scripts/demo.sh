#!/usr/bin/env bash
# Opens several real Claude Code sessions, each steered into a
# different state. Most scenarios are worded so no keyword rule matches: the ranking and the
# reasons shown in the TUI then come from the local model (Ollama).
set -euo pipefail

SELF="$(readlink -f "${BASH_SOURCE[0]}")"
DEMO_DIR="${ATTENTION_DEMO_DIR:-${TMPDIR:-/tmp}/attention-demo}"
MODEL="${ATTENTION_DEMO_MODEL:-}"
SCENARIOS=(soft-question hidden-risk benign-failure needs-approval risky-cleanup quick-done)

usage() {
  cat <<EOF
Usage: scripts/demo.sh [--tmux] [--tui] [--only a,b] [--clean]

Opens one Claude Code session per scenario, each in its own terminal window (or tmux
window with --tmux). It does not open the attention TUI: run "attention" in a terminal of
your own first (it starts the receiver the sessions report to), or pass --tui. Every session runs in its own folder under
$DEMO_DIR, so its label in the TUI is the scenario name.

Scenarios (the first three are decided by the local AI; no keyword rule matches them):
  soft-question   ends its turn asking you to choose, without a question mark
  hidden-risk     asks to empty a customer records file, with none of the risky keywords
  benign-failure  runs a command that fails harmlessly, which the AI should not escalate
  needs-approval  asks to write a file and waits on the permission prompt
  risky-cleanup   asks to run rm -rf on its build folder (deny it to keep it); a keyword rule
                  flags it and the AI explains why
  quick-done      answers in one word and goes idle

Options:
  --tmux      use one tmux session "attention-demo" instead of desktop windows
  --tui       also open the attention TUI in its own window
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
    soft-question) echo "I need a small greeting script here. Before you write any code, tell me which of Python or Go you would rather I get, then stop and wait for my decision." ;;
    hidden-risk) echo "customers.csv in this folder is the live list the support team works from. Replace its contents with just the header row so we can start fresh, and do nothing else." ;;
    benign-failure) echo "Run 'cat missing-notes.txt' once. If it does not exist, just tell me in one sentence and stop; do not try to fix it." ;;
    needs-approval) echo "Create a file named notes.txt in this folder containing one line: 'attention demo'. Do not do anything else." ;;
    risky-cleanup) echo "This folder is running out of space. Delete the build directory by running exactly: rm -rf build" ;;
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
  [[ "$name" == "benign-failure" ]] && args+=(--allowedTools "Bash(cat:*)")
  [[ "$name" == "risky-cleanup" ]] && args+=(--settings '{"permissions":{"ask":["Bash(rm:*)"]}}')
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
  if [[ -d "$DEMO_DIR/hidden-risk" ]]; then
    printf 'name,email,plan\nAda Lovelace,ada@example.com,pro\nAlan Turing,alan@example.com,team\n' >"$DEMO_DIR/hidden-risk/customers.csv"
  fi
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
  local use_tmux=0 with_tui=0 only=""
  while (( $# )); do
    case "$1" in
      --session) run_session "$2"; exit 0 ;;
      --tmux) use_tmux=1 ;;
      --tui) with_tui=1 ;;
      --no-tui) ;;
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
  # Capture output before matching: `grep -q` exits at the first match and a still-writing
  # attention gets EPIPE, which pipefail turns into a failure.
  local hooks_status doctor_report
  hooks_status="$("$ATTENTION" hooks status 2>&1 || true)"
  grep -q "Status: *installed" <<<"$hooks_status" || die "hooks are not installed; run: attention setup"

  doctor_report="$("$ATTENTION" doctor 2>/dev/null || true)"
  grep -qiE "local model.*available" <<<"$doctor_report" \
    || echo "demo: warning: the local model is not available, so the AI scenarios will show the rule-based fallback. Run: attention doctor" >&2

  if (( ! with_tui )) && "$ATTENTION" doctor 2>/dev/null | grep -i "receiver" | grep -qi "not running"; then
    echo "demo: warning: the receiver is not running, so these sessions will not be seen. Open the TUI first with: attention" >&2
  fi

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
What to watch in the TUI (the "AI" label marks verdicts from the local model):
  - soft-question: no keyword matches, yet the AI ranks it as waiting on you and quotes the sentence that asks for your decision.
  - hidden-risk: the rules see nothing risky; the AI raises the task and explains that it empties a live customer file.
  - benign-failure: the command fails, but the AI keeps it low instead of calling it an emergency.
  - needs-approval and risky-cleanup rise to the top; risky-cleanup carries a risk flag and an AI reason.
  - quick-done shows turn complete at low priority.
  - Select a row and press Enter: the session's own window comes forward, even when minimised.
Clean up with: scripts/demo.sh --clean
EOF
}

main "$@"
