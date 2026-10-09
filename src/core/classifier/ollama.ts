import { classificationJsonSchema } from "../schemas.ts";
import { buildMessages, parseModelOutput } from "./contract.ts";
import { ClassifierError, type ClassifierInput, type ClassifierPort, type ModelHealth } from "./types.ts";

export interface OllamaOptions {
  url: string;
  model: string;
  timeoutMs: number;
  warmUpTimeoutMs?: number;
  keepAlive?: string;
  fetchImpl?: typeof fetch;
}

interface ChatResponse {
  message?: { content?: unknown };
  error?: unknown;
}

interface TagsResponse {
  models?: Array<{ name?: unknown }>;
}

function modelMatches(installed: string, wanted: string): boolean {
  if (installed === wanted) return true;
  return !wanted.includes(":") && installed === `${wanted}:latest`;
}

export function createOllamaClassifier(options: OllamaOptions): ClassifierPort {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.url.replace(/\/+$/, "");
  let supportsThinking: boolean | null = null;

  async function request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(`${base}${path}`, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new ClassifierError(`no response within ${timeoutMs}ms`, "timeout");
      throw new ClassifierError("model runtime unreachable", "unreachable");
    } finally {
      clearTimeout(timer);
    }
  }

  async function detectThinking(): Promise<boolean> {
    if (supportsThinking !== null) return supportsThinking;
    try {
      const res = await request("/api/show", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: options.model }),
      }, Math.min(options.timeoutMs, 3000));
      const info = (await res.json()) as { capabilities?: unknown };
      supportsThinking = Array.isArray(info.capabilities) && info.capabilities.includes("thinking");
    } catch {
      return false;
    }
    return supportsThinking;
  }

  async function chat(input: ClassifierInput, timeoutMs: number) {
      const thinking = await detectThinking();
      const body = {
        model: options.model,
        stream: false,
        keep_alive: options.keepAlive ?? "30m",
        format: classificationJsonSchema,
        options: { temperature: 0, num_predict: 200, num_ctx: 2048, seed: 7 },
        messages: buildMessages(input),
        ...(thinking ? { think: false } : {}),
      };
      const res = await request("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }, timeoutMs);

      let payload: ChatResponse;
      try {
        payload = (await res.json()) as ChatResponse;
      } catch {
        throw new ClassifierError(`invalid response (${res.status})`, "invalid_output");
      }
      if (res.status === 404) throw new ClassifierError(`model ${options.model} not installed`, "model_missing");
      if (!res.ok) {
        const detail = typeof payload.error === "string" ? payload.error.slice(0, 120) : `HTTP ${res.status}`;
        throw new ClassifierError(detail, /memory|resource/i.test(detail) ? "rate_limited" : "http_error");
      }
      const content = typeof payload.message?.content === "string" ? payload.message.content : "";
      const parsed = parseModelOutput(content);
      if (!parsed) throw new ClassifierError("model output failed validation", "invalid_output");
      return parsed;
  }

  return {
    classify(input: ClassifierInput) {
      return chat(input, options.timeoutMs);
    },

    async warmUp() {
      await chat({ eventType: "notification", notificationType: null, toolName: null, text: "warm up", recentFailures: 0 }, options.warmUpTimeoutMs ?? 60_000);
    },

    async health(): Promise<ModelHealth> {
      const report: ModelHealth = { reachable: false, modelInstalled: false, model: options.model, url: base, error: null };
      try {
        const res = await request("/api/tags", { method: "GET" }, Math.min(options.timeoutMs, 3000));
        if (!res.ok) {
          report.error = `HTTP ${res.status}`;
          return report;
        }
        const tags = (await res.json()) as TagsResponse;
        report.reachable = true;
        const names = (tags.models ?? []).map((m) => (typeof m.name === "string" ? m.name : "")).filter(Boolean);
        report.modelInstalled = names.some((n) => modelMatches(n, options.model));
        if (!report.modelInstalled) report.error = `model ${options.model} not installed`;
      } catch (error) {
        report.error = error instanceof ClassifierError ? error.message : "unreachable";
      }
      return report;
    },
  };
}
