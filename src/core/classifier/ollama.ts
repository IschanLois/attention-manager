import { classificationJsonSchema } from "../schemas.ts";
import { buildMessages, parseModelOutput } from "./contract.ts";
import { ClassifierError, type ClassifierInput, type ClassifierPort, type ModelHealth } from "./types.ts";

export interface OllamaOptions {
  url: string;
  model: string;
  timeoutMs: number;
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

  return {
    async classify(input: ClassifierInput) {
      const body = {
        model: options.model,
        stream: false,
        keep_alive: options.keepAlive ?? "30m",
        format: classificationJsonSchema,
        options: { temperature: 0, num_predict: 200, num_ctx: 2048, seed: 7 },
        messages: buildMessages(input),
      };
      const res = await request("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }, options.timeoutMs);

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
