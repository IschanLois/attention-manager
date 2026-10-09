import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReceiver, type Receiver } from "@/receiver/server";
import type { ClassifierPort } from "@/core/classifier/types";
import * as fx from "./fixtures/hook-events";

const TOKEN = "test-token-0123456789abcdef";

function fakeClassifier(): ClassifierPort & { calls: number } {
  const port = {
    calls: 0,
    async classify() {
      port.calls += 1;
      return null;
    },
    async health() {
      return { reachable: false, modelInstalled: false, model: "fake", url: "http://127.0.0.1:0", error: "stubbed" };
    },
  };
  return port;
}

describe("receiver", () => {
  let receiver: Receiver;
  let base: string;
  let classifier: ReturnType<typeof fakeClassifier>;

  beforeEach(async () => {
    classifier = fakeClassifier();
    receiver = await createReceiver({
      host: "127.0.0.1",
      port: 0,
      databasePath: ":memory:",
      ingestToken: TOKEN,
      maxBodyBytes: 4096,
      eventHistoryLimit: 20,
      staleAfterMs: 600_000,
      dedupeWindowMs: 60_000,
      rateLimit: { perSessionPerMinute: 60, globalPerMinute: 200 },
      classifier,
      logLevel: "error",
    });
    base = `http://127.0.0.1:${receiver.port}`;
  });

  afterEach(async () => {
    await receiver.close();
  });

  async function post(body: unknown, init: { token?: string | null; headers?: Record<string, string>; raw?: string } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json", ...init.headers };
    const token = init.token === undefined ? TOKEN : init.token;
    if (token) headers["x-attention-token"] = token;
    return fetch(`${base}/api/events`, { method: "POST", headers, body: init.raw ?? JSON.stringify(body) });
  }

  async function sessions() {
    const res = await fetch(`${base}/api/sessions`);
    return (await res.json()) as { sessions: Array<Record<string, unknown>>; now: string };
  }

  it("exposes a health endpoint", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sqlite.ok).toBe(true);
    expect(body.model.reachable).toBe(false);
    expect(body.lastEventAt).toBeNull();
  });

  it("accepts a valid hook event, updates the session, and reports it", async () => {
    const res = await post(fx.sessionStart());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    const { sessions: list } = await sessions();
    expect(list).toHaveLength(1);
    expect(list[0]!.sessionId).toBe(fx.SESSION_A);
    expect(list[0]!.status).toBe("starting");
    expect(list[0]!.stale).toBe(false);
    const health = await (await fetch(`${base}/api/health`)).json();
    expect(typeof health.lastEventAt).toBe("string");
  });

  it("keeps separate records for separate sessions", async () => {
    await post(fx.sessionStart(fx.SESSION_A));
    await post(fx.permissionRequest(fx.SESSION_B));
    const { sessions: list } = await sessions();
    expect(list.map((s) => s.sessionId).sort()).toEqual([fx.SESSION_A, fx.SESSION_B].sort());
    const b = list.find((s) => s.sessionId === fx.SESSION_B)!;
    expect(b.status).toBe("needs_attention");
    expect(b.priority).toBe("high");
  });

  it("orders sessions by priority before recency", async () => {
    await post(fx.sessionStart(fx.SESSION_B));
    await post(fx.permissionRequest(fx.SESSION_B));
    await post(fx.sessionStart(fx.SESSION_A));
    const { sessions: list } = await sessions();
    expect(list[0]!.sessionId).toBe(fx.SESSION_B);
  });

  it("returns a session with its bounded recent events", async () => {
    await post(fx.sessionStart());
    await post(fx.userPromptSubmit());
    await post(fx.preToolUse());
    const res = await fetch(`${base}/api/sessions/${fx.SESSION_A}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session.sessionId).toBe(fx.SESSION_A);
    expect(body.events.map((e: { eventType: string }) => e.eventType)).toEqual(["tool_start", "prompt", "session_start"]);
    expect(JSON.stringify(body)).not.toContain("node hello.js");
  });

  it("returns 404 for unknown sessions and rejects malformed ids", async () => {
    expect((await fetch(`${base}/api/sessions/${fx.SESSION_A}`)).status).toBe(404);
    expect((await fetch(`${base}/api/sessions/..%2F..%2Fetc`)).status).toBe(400);
  });

  it("ignores unsupported hook events without creating sessions", async () => {
    const res = await post(fx.instructionsLoaded());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: false, reason: "unsupported_event" });
    expect((await sessions()).sessions).toHaveLength(0);
  });

  it("rejects malformed JSON and invalid payloads without crashing", async () => {
    expect((await post(null, { raw: "{not json" })).status).toBe(400);
    expect((await post({ hook_event_name: "SessionStart" })).status).toBe(400);
    expect((await post("just a string")).status).toBe(400);
    expect((await post([1, 2, 3])).status).toBe(400);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it("rejects bodies over the configured size limit", async () => {
    const res = await post({ ...fx.userPromptSubmit(), prompt: "x".repeat(10_000) });
    expect(res.status).toBe(413);
  });

  it("requires the JSON content type and the ingest token", async () => {
    expect((await post(fx.sessionStart(), { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await post(fx.sessionStart(), { token: null })).status).toBe(401);
    expect((await post(fx.sessionStart(), { token: "wrong" })).status).toBe(401);
    expect((await sessions()).sessions).toHaveLength(0);
  });

  it("rejects requests whose Host header is not loopback", async () => {
    const { request } = await import("node:http");
    const statusWithHost = (method: string, path: string, host: string, body?: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port: receiver.port, method, path, headers: { host, "content-type": "application/json", "x-attention-token": TOKEN } },
          (res) => { res.resume(); resolve(res.statusCode ?? 0); },
        );
        req.on("error", reject);
        req.end(body);
      });
    expect(await statusWithHost("POST", "/api/events", "evil.example.com", JSON.stringify(fx.sessionStart()))).toBe(403);
    expect(await statusWithHost("GET", "/api/sessions", "evil.example.com:4318")).toBe(403);
    expect(await statusWithHost("GET", "/api/sessions", "localhost:4318")).toBe(200);
    expect(await statusWithHost("GET", "/api/sessions", "[::1]:4318")).toBe(200);
  });

  it("rejects browser-originated cross-site requests and never sends CORS headers", async () => {
    const res = await post(fx.sessionStart(), { headers: { origin: "http://attacker.test" } });
    expect(res.status).toBe(403);
    const get = await fetch(`${base}/api/sessions`, { headers: { origin: "http://attacker.test" } });
    expect(get.status).toBe(403);
    expect(get.headers.get("access-control-allow-origin")).toBeNull();
    const ok = await fetch(`${base}/api/sessions`, { headers: { origin: "http://localhost:3000" } });
    expect(ok.status).toBe(200);
  });

  it("drops exact duplicate events inside the dedupe window", async () => {
    await post(fx.sessionStart(fx.SESSION_B));
    expect(await (await post(fx.permissionRequest())).json()).toEqual({ accepted: true });
    expect(await (await post(fx.permissionRequest())).json()).toEqual({ accepted: false, reason: "duplicate" });
    const body = await (await fetch(`${base}/api/sessions/${fx.SESSION_B}`)).json();
    expect(body.events.filter((e: { eventType: string }) => e.eventType === "permission_request")).toHaveLength(1);
  });

  it("rate limits floods per session", async () => {
    const flooded = await createReceiver({
      host: "127.0.0.1",
      port: 0,
      databasePath: ":memory:",
      ingestToken: TOKEN,
      maxBodyBytes: 4096,
      eventHistoryLimit: 20,
      staleAfterMs: 600_000,
      dedupeWindowMs: 0,
      rateLimit: { perSessionPerMinute: 3, globalPerMinute: 1000 },
      classifier,
      logLevel: "error",
    });
    try {
      const url = `http://127.0.0.1:${flooded.port}/api/events`;
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-attention-token": TOKEN },
          body: JSON.stringify(fx.preToolUse(fx.SESSION_A, `t${i}`)),
        });
        statuses.push(res.status);
      }
      expect(statuses).toEqual([202, 202, 202, 429, 429]);
    } finally {
      await flooded.close();
    }
  });

  it("streams a snapshot and then session updates over SSE", async () => {
    await post(fx.sessionStart(fx.SESSION_A));
    const controller = new AbortController();
    const res = await fetch(`${base}/api/stream`, { signal: controller.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readUntil = async (predicate: (text: string) => boolean) => {
      const deadline = Date.now() + 5000;
      while (!predicate(buffer)) {
        if (Date.now() > deadline) throw new Error(`timeout waiting; buffer=${buffer}`);
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
    };
    await readUntil((t) => t.includes("event: snapshot"));
    expect(buffer).toContain(fx.SESSION_A);
    await post(fx.permissionRequest(fx.SESSION_B));
    await readUntil((t) => t.includes("event: session") && t.includes(fx.SESSION_B));
    expect(buffer).toMatch(/"status":"needs_attention"/);
    controller.abort();
  });

  it("only invokes the classifier for ambiguous events", async () => {
    await post(fx.sessionStart(fx.SESSION_B));
    await post(fx.permissionRequest());
    await post(fx.preToolUse(fx.SESSION_B));
    expect(classifier.calls).toBe(0);
    await post(fx.unknownNotification());
    await new Promise((r) => setTimeout(r, 50));
    expect(classifier.calls).toBe(1);
  });

  it("restores persisted sessions after restart", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "attention-receiver-"));
    const opts = {
      host: "127.0.0.1", port: 0, databasePath: join(dir, "db.sqlite"), ingestToken: TOKEN, maxBodyBytes: 4096,
      eventHistoryLimit: 20, staleAfterMs: 600_000, dedupeWindowMs: 0,
      rateLimit: { perSessionPerMinute: 60, globalPerMinute: 200 }, classifier, logLevel: "error" as const,
    };
    const first = await createReceiver(opts);
    await fetch(`http://127.0.0.1:${first.port}/api/events`, {
      method: "POST", headers: { "content-type": "application/json", "x-attention-token": TOKEN },
      body: JSON.stringify(fx.permissionRequest()),
    });
    await first.close();
    const second = await createReceiver(opts);
    try {
      const body = await (await fetch(`http://127.0.0.1:${second.port}/api/sessions`)).json();
      expect(body.sessions[0].sessionId).toBe(fx.SESSION_B);
      expect(body.sessions[0].status).toBe("needs_attention");
    } finally {
      await second.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
