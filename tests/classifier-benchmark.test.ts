import { describe, expect, it } from "vitest";
import { benchmarkModel, pickBestModel, type BenchmarkResult } from "@/core/classifier/benchmark";
import type { BenchmarkCase } from "@/core/classifier/benchmark-cases";
import type { ClassifierPort } from "@/core/classifier/types";

const cases: BenchmarkCase[] = [
  { id: "a", input: { eventType: "notification", notificationType: null, toolName: null, text: "a", recentFailures: 0 }, expect: { needs_attention: true, priority: ["high"] } },
  { id: "b", input: { eventType: "notification", notificationType: null, toolName: null, text: "b", recentFailures: 0 }, expect: { needs_attention: false, priority: ["none", "low"] } },
  { id: "c", input: { eventType: "notification", notificationType: null, toolName: null, text: "c", recentFailures: 0 }, expect: { needs_attention: true, priority: ["medium"] } },
];

function classifier(answers: Record<string, { needs_attention: boolean; priority: string } | "error" | null>): ClassifierPort {
  return {
    health: async () => ({ reachable: true, modelInstalled: true, model: "m", url: "u", error: null }),
    classify: async (input) => {
      const answer = answers[input.text];
      if (answer === "error") throw new Error("boom");
      return answer ? ({ ...answer, reason: "r", confidence: 1 } as never) : null;
    },
  };
}

function result(model: string, attentionHits: number, priorityHits: number, p50Ms: number, invalid = 0): BenchmarkResult {
  return { model, total: 10, attentionHits, priorityHits, invalid, p50Ms };
}

describe("benchmarkModel", () => {
  it("scores attention and priority separately and counts unusable answers", async () => {
    const outcome = await benchmarkModel("m", classifier({ a: { needs_attention: true, priority: "high" }, b: { needs_attention: true, priority: "low" }, c: "error" }), cases, () => 0);
    expect(outcome).toMatchObject({ model: "m", total: 3, attentionHits: 1, priorityHits: 2, invalid: 1 });
  });

  it("treats an answer the client could not parse as invalid", async () => {
    const outcome = await benchmarkModel("m", classifier({ a: null, b: null, c: null }), cases, () => 0);
    expect(outcome).toMatchObject({ attentionHits: 0, priorityHits: 0, invalid: 3 });
  });

  it("reports the median latency of the answered cases", async () => {
    const ticks = [0, 100, 100, 400, 400, 1000];
    let i = 0;
    const outcome = await benchmarkModel("m", classifier({ a: { needs_attention: true, priority: "high" }, b: { needs_attention: false, priority: "low" }, c: { needs_attention: true, priority: "medium" } }), cases, () => ticks[i++]);
    expect(outcome.p50Ms).toBe(300);
  });
});

describe("pickBestModel", () => {
  it("prefers the most accurate model that answers within the latency budget", () => {
    const pick = pickBestModel([result("small", 8, 8, 800), result("big", 10, 9, 2500), result("huge", 10, 10, 9000)], 3000);
    expect(pick).toEqual({ model: "big", withinBudget: true });
  });

  it("breaks accuracy ties with the faster model", () => {
    expect(pickBestModel([result("slow", 9, 9, 2000), result("fast", 9, 9, 700)], 3000)?.model).toBe("fast");
  });

  it("ignores models whose answers are mostly unusable", () => {
    expect(pickBestModel([result("broken", 10, 10, 300, 6), result("ok", 7, 7, 900)], 3000)?.model).toBe("ok");
  });

  it("falls back to the fastest model when none meets the budget", () => {
    expect(pickBestModel([result("a", 10, 10, 8000), result("b", 6, 6, 5000)], 3000)).toEqual({ model: "b", withinBudget: false });
  });

  it("returns null when there is nothing to choose from", () => {
    expect(pickBestModel([], 3000)).toBeNull();
  });
});
