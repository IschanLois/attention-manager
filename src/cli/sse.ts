import { request, type ClientRequest } from "node:http";
import type { ConnectionState } from "./model/types.ts";

export interface SseFrame {
  event: string;
  data: string;
}

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 15_000;
const OFFLINE_AFTER_FAILURES = 3;
// The receiver sends a heartbeat every 15s; silence well beyond that means a dead socket.
const IDLE_TIMEOUT_MS = 40_000;

export function parseSseChunk(buffer: string): { events: SseFrame[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: SseFrame[] = [];
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length > 0) events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
  return Math.round(base * (0.8 + 0.4 * random()));
}

export function connectionStateAfterFailure(failures: number): ConnectionState {
  return failures >= OFFLINE_AFTER_FAILURES ? "offline" : "reconnecting";
}

export interface StreamHandlers {
  onFrame(frame: SseFrame): void;
  onState(state: ConnectionState, retryAt: number | null): void;
}

export interface StreamController {
  reconnectNow(): void;
  close(): void;
}

export function connectStream(baseUrl: string, handlers: StreamHandlers): StreamController {
  let failures = 0;
  let closed = false;
  let current: ClientRequest | null = null;
  let retryTimer: NodeJS.Timeout | null = null;

  const scheduleRetry = () => {
    if (closed) return;
    current = null;
    failures += 1;
    const delay = backoffDelay(failures - 1);
    handlers.onState(connectionStateAfterFailure(failures), Date.now() + delay);
    retryTimer = setTimeout(open, delay);
  };

  function open(): void {
    if (closed) return;
    retryTimer = null;
    let failed = false;
    const failOnce = () => {
      if (failed) return;
      failed = true;
      scheduleRetry();
    };
    const req = request(`${baseUrl}/api/stream`, { headers: { accept: "text/event-stream" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return failOnce();
      }
      failures = 0;
      handlers.onState("live", null);
      res.setEncoding("utf8");
      let buffer = "";
      res.on("data", (chunk: string) => {
        const parsed = parseSseChunk(buffer + chunk);
        buffer = parsed.rest;
        for (const frame of parsed.events) handlers.onFrame(frame);
      });
      res.on("end", failOnce);
      res.on("error", failOnce);
    });
    req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error("stream idle")));
    req.on("error", failOnce);
    req.end();
    current = req;
  }

  open();
  return {
    reconnectNow() {
      if (closed) return;
      if (retryTimer) clearTimeout(retryTimer);
      current?.destroy();
      current = null;
      failures = 0;
      open();
    },
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      current?.destroy();
    },
  };
}
