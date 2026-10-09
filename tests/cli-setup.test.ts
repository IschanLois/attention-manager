import { describe, expect, it } from "vitest";
import { configSchema, DEFAULT_CONFIG, type CliConfig } from "@/cli/config";
import type { BenchmarkResult } from "@/core/classifier/benchmark";
import { runSetup, type Prompter, type SetupDeps } from "@/cli/setup";

type Answer = boolean | string | null;

function fakePrompter(answers: Answer[]): Prompter & { questions: string[]; messages: string[] } {
  const queue = [...answers];
  const questions: string[] = [];
  const messages: string[] = [];
  const next = (question: string) => {
    questions.push(question);
    if (queue.length === 0) throw new Error(`unexpected question: ${question}`);
    return queue.shift()!;
  };
  return {
    questions,
    messages,
    intro: (t) => messages.push(t),
    note: (t) => messages.push(t),
    info: (t) => messages.push(t),
    warn: (t) => messages.push(t),
    success: (t) => messages.push(t),
    outro: (t) => messages.push(t),
    confirm: async (message) => next(message) as boolean | null,
    select: async (message) => next(message) as string | null,
    text: async (message) => next(message) as string | null,
  };
}

function deps(overrides: Partial<SetupDeps> & { answers?: Answer[] } = {}) {
  const calls = { installed: 0, token: 0, testFocus: 0, saved: null as CliConfig | null, probes: [] as string[] };
  const prompter = fakePrompter(overrides.answers ?? []);
  const base: SetupDeps = {
    prompter,
    yes: false,
    existing: DEFAULT_CONFIG,
    platform: "linux",
    hooks: {
      settingsPath: "/home/ada/.claude/settings.json",
      plan: () => ({ added: ["Stop", "Notification"], replaced: [], unchanged: false }),
      install: () => {
        calls.installed += 1;
      },
    },
    ensureToken: () => {
      calls.token += 1;
    },
    probeOllama: async (url, model) => {
      calls.probes.push(`${url} ${model}`);
      return { reachable: true, modelInstalled: true };
    },
    benchmarkModels: async () => ({ reachable: true, results: [] }),
    terminal: {
      backends: ["tmux", "x11"],
      wayland: false,
      testFocus: async () => {
        calls.testFocus += 1;
        return { kind: "focused", via: ["tmux"], notes: [] };
      },
    },
    save: (config) => {
      calls.saved = config;
    },
  };
  return { deps: { ...base, ...overrides, prompter }, calls, prompter };
}

describe("runSetup", () => {
  it("asks at most three questions on the default path and saves the answers", async () => {
    const { deps: d, calls, prompter } = deps({ answers: [true, "default", true] });
    const result = await runSetup(d);
    expect(result.ok).toBe(true);
    expect(prompter.questions).toHaveLength(3);
    expect(prompter.questions[0]).toMatch(/Install the Claude Code hooks.*settings\.json/);
    expect(calls).toMatchObject({ installed: 1, token: 1, testFocus: 1, probes: ["http://127.0.0.1:11434 qwen3:1.7b"] });
    expect(calls.saved).toEqual(configSchema.parse({ terminal: { confirmed: "tmux+x11" } }));
  });

  it("uses the defaults without prompting in --yes mode and skips the focus test", async () => {
    const { deps: d, calls, prompter } = deps({ yes: true });
    const result = await runSetup(d);
    expect(result.ok).toBe(true);
    expect(prompter.questions).toEqual([]);
    expect(calls).toMatchObject({ installed: 1, token: 1, testFocus: 0 });
    expect(calls.saved?.classifier.enabled).toBe(true);
  });

  it("leaves the hooks alone when declined and does not ask when they are already current", async () => {
    const declined = deps({ answers: [false, "default", false] });
    await runSetup(declined.deps);
    expect(declined.calls.installed).toBe(0);
    expect(declined.prompter.messages.join("\n")).toMatch(/attention hooks install/);

    const current = deps({ answers: ["default", false], hooks: { settingsPath: "/s.json", plan: () => ({ added: [], replaced: [], unchanged: true }), install: () => undefined } });
    await runSetup(current.deps);
    expect(current.prompter.questions).toHaveLength(2);
  });

  it("turns local AI off without probing Ollama", async () => {
    const { deps: d, calls } = deps({ answers: [true, "off", false] });
    await runSetup(d);
    expect(calls.probes).toEqual([]);
    expect(calls.saved?.classifier.enabled).toBe(false);
  });

  it("asks for a custom URL and model only when requested", async () => {
    const { deps: d, calls, prompter } = deps({ answers: [true, "custom", "http://127.0.0.1:9999", "llama3.2:1b", false] });
    await runSetup(d);
    expect(prompter.questions).toHaveLength(5);
    expect(calls.probes).toEqual(["http://127.0.0.1:9999 llama3.2:1b"]);
    expect(calls.saved?.classifier).toEqual({ enabled: true, ollamaUrl: "http://127.0.0.1:9999", model: "llama3.2:1b" });
  });

  it("prints the exact pull command for a missing model and never pulls it", async () => {
    const { deps: d, prompter } = deps({ answers: [true, "default", false], probeOllama: async () => ({ reachable: true, modelInstalled: false }) });
    await runSetup(d);
    expect(prompter.messages.join("\n")).toMatch(/ollama pull qwen3:1\.7b/);
  });

  it("explains an unreachable Ollama but keeps AI enabled for later", async () => {
    const { deps: d, prompter, calls } = deps({ answers: [true, "default", false], probeOllama: async () => ({ reachable: false, modelInstalled: false }) });
    await runSetup(d);
    expect(prompter.messages.join("\n")).toMatch(/not reachable at http:\/\/127\.0\.0\.1:11434/);
    expect(calls.saved?.classifier.enabled).toBe(true);
  });

  it("does not ask about terminal focus when nothing can focus this shell, and says why on Wayland", async () => {
    const { deps: d, prompter, calls } = deps({ answers: [true, "default"], terminal: { backends: [], wayland: true, testFocus: async () => ({ kind: "unsupported", hint: "" }) } });
    await runSetup(d);
    expect(prompter.questions).toHaveLength(2);
    expect(prompter.messages.join("\n")).toMatch(/Wayland has no generic window-focus API/);
    expect(calls.saved?.terminal.confirmed).toBeNull();
  });

  it("warns about the macOS Automation prompt before testing iTerm2 focus", async () => {
    const { deps: d, prompter } = deps({ platform: "darwin", answers: [true, "default", true], terminal: { backends: ["iterm"], wayland: false, testFocus: async () => ({ kind: "focused", via: ["iterm"], notes: [] }) } });
    await runSetup(d);
    expect(prompter.messages.join("\n")).toMatch(/Automation/);
  });

  it("pre-fills the current answers when re-run", async () => {
    const existing = configSchema.parse({ classifier: { enabled: false } });
    let initial: string | undefined;
    const { deps: d } = deps({ existing, answers: [true, "off", false] });
    const select = d.prompter.select;
    d.prompter.select = async (message, options, init) => {
      initial = init;
      return select(message, options, init);
    };
    await runSetup(d);
    expect(initial).toBe("off");
  });

  it("stops without saving when cancelled", async () => {
    const { deps: d, calls } = deps({ answers: [true, null] });
    const result = await runSetup(d);
    expect(result).toEqual({ ok: false, cancelled: true });
    expect(calls.saved).toBeNull();
  });
  describe("benchmark choice", () => {
    const result = (model: string, hits: number, p50Ms: number): BenchmarkResult => ({ model, total: 10, attentionHits: hits, priorityHits: hits, invalid: 0, p50Ms });

    it("saves the most accurate installed model that is fast enough on this device", async () => {
      const { deps: d, calls, prompter } = deps({
        answers: [true, "benchmark", false],
        benchmarkModels: async () => ({ reachable: true, results: [result("qwen3:1.7b", 8, 900), result("qwen3:4b", 9, 2400), result("qwen3:8b", 10, 12000)] }),
      });
      await runSetup(d);
      expect(calls.saved?.classifier).toEqual({ enabled: true, ollamaUrl: "http://127.0.0.1:11434", model: "qwen3:4b" });
      expect(prompter.messages.join("\n")).toMatch(/qwen3:8b.*12\.0 s/s);
    });

    it("says so when no model answers fast enough and uses the fastest", async () => {
      const { deps: d, calls, prompter } = deps({
        answers: [true, "benchmark", false],
        benchmarkModels: async () => ({ reachable: true, results: [result("qwen3:4b", 9, 8000), result("qwen3:1.7b", 7, 5000)] }),
      });
      await runSetup(d);
      expect(calls.saved?.classifier.model).toBe("qwen3:1.7b");
      expect(prompter.messages.join("\n")).toMatch(/slow for this device/);
    });

    it("keeps the default model and prints the pull command when nothing is installed", async () => {
      const { deps: d, calls, prompter } = deps({ answers: [true, "benchmark", false], benchmarkModels: async () => ({ reachable: true, results: [] }) });
      await runSetup(d);
      expect(calls.saved?.classifier).toEqual({ enabled: true, ollamaUrl: "http://127.0.0.1:11434", model: "qwen3:1.7b" });
      expect(prompter.messages.join("\n")).toMatch(/ollama pull qwen3:1\.7b/);
    });

    it("keeps AI enabled with the default model when Ollama is unreachable", async () => {
      const { deps: d, calls, prompter } = deps({ answers: [true, "benchmark", false], benchmarkModels: async () => ({ reachable: false, results: [] }) });
      await runSetup(d);
      expect(calls.saved?.classifier.enabled).toBe(true);
      expect(prompter.messages.join("\n")).toMatch(/not reachable/);
    });

    it("never benchmarks in --yes mode", async () => {
      let ran = 0;
      const { deps: d } = deps({ yes: true, benchmarkModels: async () => ((ran += 1), { reachable: true, results: [] }) });
      await runSetup(d);
      expect(ran).toBe(0);
    });
  });

});
