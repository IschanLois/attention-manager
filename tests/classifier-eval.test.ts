import { describe, expect, it } from "vitest";
import { createOllamaClassifier } from "@/core/classifier/ollama";
import type { ClassifierInput, ClassifierPort } from "@/core/classifier/types";
import { normalizeHookEvent } from "@/core/events/normalize";
import { reduceSession, shouldClassify } from "@/core/sessions/state-machine";
import { BENCHMARK_CASES as cases } from "@/core/classifier/benchmark-cases";
import * as fx from "./fixtures/hook-events";

interface EvalCase {
  id: string;
  input: ClassifierInput;
  expect: { needs_attention: boolean; priority: string[] };
}

const evalCases = cases as EvalCase[];

describe("classifier evaluation fixtures", () => {
  it("has well-formed cases", () => {
    expect(evalCases.length).toBeGreaterThanOrEqual(15);
    for (const c of evalCases) {
      expect(c.id).toBeTruthy();
      expect(c.expect.priority.length).toBeGreaterThan(0);
      expect(c.input.text.length).toBeLessThanOrEqual(2000);
    }
  });

  it("runs every fixture through the client against a mocked model that echoes the expectation", async () => {
    const classifier = createOllamaClassifier({
      url: "http://127.0.0.1:1",
      model: "mock",
      timeoutMs: 100,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
        const userText = body.messages[1]!.content;
        const match = evalCases.find((c) => c.input.text.length > 0 && userText.includes(c.input.text.replace(/\s+/g, " ").slice(0, 40).replace(/<\/?event/gi, "&lt;event")));
        const expected = match?.expect ?? { needs_attention: false, priority: ["none"] };
        const content = JSON.stringify({
          needs_attention: expected.needs_attention,
          priority: expected.priority[0],
          reason: `mock for ${match?.id ?? "unknown"}`,
          evidence: [],
          confidence: 0.5,
        });
        return new Response(JSON.stringify({ message: { content } }), { status: 200 });
      }) as typeof fetch,
    });
    for (const c of evalCases) {
      if (!c.input.text) continue;
      const result = await classifier.classify(c.input);
      expect(result, c.id).not.toBeNull();
      expect(result!.needs_attention, c.id).toBe(c.expect.needs_attention);
      expect(c.expect.priority, c.id).toContain(result!.priority);
    }
  });
});

describe("deterministic path is independent of the model", () => {
  const broken: ClassifierPort = {
    async classify() {
      throw new Error("model exploded");
    },
    async health() {
      return { reachable: false, modelInstalled: false, model: "x", url: "y", error: "down" };
    },
  };

  it("rules decide permission requests, completion and ends without any model call", async () => {
    const start = normalizeHookEvent(fx.sessionStart(fx.SESSION_B), "2026-10-09T08:00:00.000Z");
    const perm = normalizeHookEvent(fx.permissionRequest(), "2026-10-09T08:00:01.000Z");
    const end = normalizeHookEvent(fx.sessionEnd(fx.SESSION_B), "2026-10-09T08:00:02.000Z");
    if (!start.ok || !perm.ok || !end.ok) throw new Error("fixture");
    const s1 = reduceSession(reduceSession(null, start.event), perm.event);
    expect(s1.status).toBe("needs_attention");
    expect(shouldClassify(s1, perm.event)).toBe(false);
    await expect(broken.classify({ eventType: "notification", notificationType: null, toolName: null, text: "x", recentFailures: 0 })).rejects.toThrow();
    const s2 = reduceSession(s1, end.event);
    expect(s2.status).toBe("ended");
  });
});
