// Opt-in live evaluation of the classifier against Ollama. Not part of `pnpm test`.
// Usage: OLLAMA_URL=http://127.0.0.1:11434 node --no-warnings=ExperimentalWarning scripts/eval-classifier.ts [--task] [model ...]
// --task evaluates the task-severity prompt against tests/fixtures/task-cases.json instead.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOllamaClassifier } from "../src/core/classifier/ollama.ts";
import type { ClassifierInput, TaskClassifierInput } from "../src/core/classifier/types.ts";

interface EvalCase {
  id: string;
  input: ClassifierInput;
  expect: { needs_attention: boolean; priority: string[] };
}

const url = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const args = process.argv.slice(2);
const taskMode = args.includes("--task");
const modelArgs = args.filter((a) => a !== "--task");
const models = modelArgs.length ? modelArgs : [process.env.OLLAMA_MODEL ?? "qwen3:1.7b"];
const cases = JSON.parse(readFileSync(resolve(import.meta.dirname, "../tests/fixtures/classifier-cases.json"), "utf8")) as EvalCase[];

interface TaskCase {
  id: string;
  input: TaskClassifierInput;
  expect: { priority: string[] };
}
const taskCases = JSON.parse(readFileSync(resolve(import.meta.dirname, "../tests/fixtures/task-cases.json"), "utf8")) as TaskCase[];

async function evaluateTasks(model: string): Promise<void> {
  const classifier = createOllamaClassifier({ url, model, timeoutMs: 120_000 });
  const health = await classifier.health();
  if (!health.reachable || !health.modelInstalled) {
    console.log(`${model}: skipped (${health.error ?? "unavailable"})`);
    return;
  }
  let hits = 0;
  let invalid = 0;
  const latencies: number[] = [];
  const misses: string[] = [];
  for (const c of taskCases) {
    const started = performance.now();
    try {
      const result = await classifier.classifyTask!(c.input);
      latencies.push(performance.now() - started);
      if (!result) {
        invalid++;
        continue;
      }
      if (c.expect.priority.includes(result.priority)) hits++;
      else misses.push(`${c.id}: got ${result.priority}, want ${c.expect.priority.join("|")} (${result.reason})`);
    } catch (error) {
      invalid++;
      misses.push(`${c.id}: error ${(error as Error).message}`);
    }
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  console.log(`\n== ${model} (task severity) ==`);
  console.log(`priority accuracy: ${hits}/${taskCases.length}  invalid/errors: ${invalid}  latency p50 ${(sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(0)}ms`);
  for (const m of misses) console.log(`  miss ${m}`);
}

for (const model of models) {
  if (taskMode) {
    await evaluateTasks(model);
    continue;
  }
  const classifier = createOllamaClassifier({ url, model, timeoutMs: 120_000 });
  const health = await classifier.health();
  if (!health.reachable || !health.modelInstalled) {
    console.log(`${model}: skipped (${health.error ?? "unavailable"})`);
    continue;
  }
  await classifier.classify({ eventType: "notification", notificationType: null, toolName: null, text: "warm up", recentFailures: 0 }).catch(() => null);

  let attentionHits = 0;
  let priorityHits = 0;
  let invalid = 0;
  const latencies: number[] = [];
  const misses: string[] = [];
  for (const c of cases) {
    if (!c.input.text) continue;
    const started = performance.now();
    try {
      const result = await classifier.classify(c.input);
      latencies.push(performance.now() - started);
      if (!result) {
        invalid++;
        continue;
      }
      const attentionOk = result.needs_attention === c.expect.needs_attention;
      const priorityOk = c.expect.priority.includes(result.priority);
      if (attentionOk) attentionHits++;
      if (priorityOk) priorityHits++;
      if (!attentionOk || !priorityOk) misses.push(`${c.id}: got ${result.needs_attention}/${result.priority}, want ${c.expect.needs_attention}/${c.expect.priority.join("|")}`);
    } catch (error) {
      invalid++;
      latencies.push(performance.now() - started);
      misses.push(`${c.id}: error ${(error as Error).message}`);
    }
  }
  const total = cases.filter((c) => c.input.text).length;
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  console.log(`\n== ${model} ==`);
  console.log(`needs_attention accuracy: ${attentionHits}/${total}  priority accuracy: ${priorityHits}/${total}  invalid/errors: ${invalid}`);
  console.log(`latency p50 ${p50.toFixed(0)}ms  p95 ${p95.toFixed(0)}ms`);
  for (const m of misses) console.log(`  miss ${m}`);
}
