# Worklog: benchmark models during setup

Tracking number: none (the project opted out of Jira/Linear ids).

## Purpose

The best local model depends on the device: on a 4 GB GPU the 1.7B model beats the 4B on latency, while a laptop with more VRAM can run larger models quickly. Setup now offers to measure the installed models on the current device and save the best one.

## Changes

- `src/core/classifier/benchmark-cases.ts` (moved from `tests/fixtures/classifier-cases.json`): the fixture cases ship with the package; the eval script and tests import them.
- `src/core/classifier/benchmark.ts`: `benchmarkModel` (accuracy, unusable answers, median latency) and `pickBestModel`.
- `src/core/classifier/ollama.ts`: `listInstalledModels`.
- `src/cli/setup.ts`: new "benchmark" choice in the AI question; prints a per-model table and the pick.
- `src/cli/commands/setup.ts`: `benchmarkModels` dependency (warm-up, then the cases, 15 s per call).
- `README.md`: setup step documented.

## Decisions

- **Selection rule:** most accurate (needs-attention hits + priority hits) among models with median latency within 3 s; ties go to the faster model. If none is within budget, the fastest usable model is chosen and setup says so.
- **Unusable models excluded:** more than 25% invalid or timed-out answers disqualifies a model (also filters out embedding-only models).
- **Installed models only.** Setup never pulls a model; with none installed it prints the pull command and keeps the default.
- **Not in `--yes` mode:** a benchmark takes minutes.
- Measured on a GTX 1650: `qwen3:1.7b` scored 16/19 and 18/19 with a 1.4 s median, matching the README table.

## Test plan

Automated: `tests/classifier-benchmark.test.ts` (scoring, median latency, pick rule, ties, budget fallback, unusable models); `tests/cli-setup.test.ts` (benchmark choice saves the pick, slow-device message, nothing installed, Ollama unreachable, `--yes` never benchmarks).

Manual: `attention setup`, choose the benchmark option with several models installed, check the table and the saved `classifier.model` in `config.json`.
