import type { BenchmarkCase } from "./benchmark-cases.ts";
import type { ClassifierPort } from "./types.ts";

export interface BenchmarkResult {
  model: string;
  total: number;
  attentionHits: number;
  priorityHits: number;
  invalid: number;
  p50Ms: number;
}

export interface ModelPick {
  model: string;
  withinBudget: boolean;
}

export const DEFAULT_LATENCY_BUDGET_MS = 3000;
const MAX_INVALID_SHARE = 0.25;

export async function benchmarkModel(model: string, classifier: ClassifierPort, cases: BenchmarkCase[], now: () => number = () => performance.now()): Promise<BenchmarkResult> {
  const scored = cases.filter((c) => c.input.text);
  let attentionHits = 0;
  let priorityHits = 0;
  let invalid = 0;
  const latencies: number[] = [];
  for (const c of scored) {
    const started = now();
    try {
      const answer = await classifier.classify(c.input);
      latencies.push(now() - started);
      if (!answer) {
        invalid++;
        continue;
      }
      if (answer.needs_attention === c.expect.needs_attention) attentionHits++;
      if (c.expect.priority.includes(answer.priority)) priorityHits++;
    } catch {
      invalid++;
    }
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  return { model, total: scored.length, attentionHits, priorityHits, invalid, p50Ms: sorted[Math.floor(sorted.length / 2)] ?? 0 };
}

// Most accurate model that answers within the latency budget; when none does, the fastest usable one.
export function pickBestModel(results: BenchmarkResult[], latencyBudgetMs: number = DEFAULT_LATENCY_BUDGET_MS): ModelPick | null {
  const usable = results.filter((r) => r.total > 0 && r.invalid <= r.total * MAX_INVALID_SHARE);
  const fast = usable.filter((r) => r.p50Ms <= latencyBudgetMs);
  if (fast.length) {
    const best = [...fast].sort((a, b) => b.attentionHits + b.priorityHits - (a.attentionHits + a.priorityHits) || a.p50Ms - b.p50Ms)[0];
    return { model: best.model, withinBudget: true };
  }
  const fastest = [...usable].sort((a, b) => a.p50Ms - b.p50Ms)[0];
  return fastest ? { model: fastest.model, withinBudget: false } : null;
}
