# Worklog: README positioning

Tracking number: none (the project opted out of Jira/Linear ids).

## Purpose

The README introduced attention as a "Claude Code Attention Manager". It now leads with what the tool is for:
- risk-first attention (semantic urgency);
- a setup benchmark of the installed local models;
- an explained reason for every ranking;
- coding agents in general, with Claude Code as the first one supported.

It also states openly how the project and its demo video were made, and which AI runs locally versus online.

## Changes

- `README.md`:
  - New title and introduction built on the four points plus privacy.
  - New "How this was built" section:
    - developed with Claude (Opus 5.5, Fable 5.1 and Sonnet 5.5 per the commit co-author credits);
    - a table of which model runs where;
    - the tools that produced the demo video (Python PTY recorder, pyte, Remotion 4 with React 19, Kokoro TTS).
- The reference sections (install, usage, configuration, privacy) are unchanged.

## Decisions

- **Other agents are stated as direction.** Only Claude Code hooks are supported today, and the README says so explicitly.
- **The risk-before-permission claim relies on PR #13 (merged).** The sentence "before it asks for permission" relies on the task-verdict fix in PR #13 (`fix/task-severity-stale`). Before that fix, AI task verdicts were usually discarded on real sessions.
- **Model credits come from the git history.** They are taken from the `Co-Authored-By` lines on `main` (Opus 5.5: 25 commits, Fable 5.1: 24, Sonnet 5.5: 9), not from memory.

## Test plan

- **Automated:** none (documentation only).
- **Manual:**
  - Read the rendered README on GitHub.
  - Check that every model and version named matches `config.json` defaults, the setup benchmark output and the demo recordings (Claude Code 2.1.295, Haiku 5.5, `qwen3:1.7b`, Kokoro `am_michael`).

## Node 24 requirement

- **Purpose:** attention only works on Node.js 24 or newer (built-in `node:sqlite`). Earlier versions fail with unclear errors.
- **Changes:**
  - `README.md`: Node 24 is called out in Setup (requirement line, a dedicated callout in step 3, the run step) and in Troubleshooting as the first thing to check on any error.
  - `src/cli/doctor.ts`: new `node` check, first in `attention doctor`. It fails as misconfiguration (exit 2) below Node 24 and hints how to install it.
- **Test plan:**
  - Automated: `tests/cli-doctor.test.ts` covers Node 22 (fail, exit 2, version in the message), 24 and 25 (ok).
  - Manual: run `attention doctor` under Node 24 and see `OK   node v24.x`.
- **Limitation:** on a Node too old to load the CLI at all, `attention doctor` cannot run, so the README tells users to check `node --version` first.
