import { describe, expect, it } from "vitest";
import { backoffDelay, connectionStateAfterFailure, parseSseChunk } from "@/cli/sse";

describe("parseSseChunk", () => {
  it("splits complete frames and keeps the partial remainder", () => {
    const { events, rest } = parseSseChunk('event: snapshot\ndata: {"a":1}\n\n: heartbeat\n\nevent: session\ndata: {"b"');
    expect(events).toEqual([{ event: "snapshot", data: '{"a":1}' }]);
    expect(rest).toBe('event: session\ndata: {"b"');
  });

  it("joins multi-line data, defaults the event name and tolerates CRLF", () => {
    const { events, rest } = parseSseChunk("data: one\r\ndata: two\r\n\r\nevent: health\ndata:{}\n\n");
    expect(events).toEqual([
      { event: "message", data: "one\ntwo" },
      { event: "health", data: "{}" },
    ]);
    expect(rest).toBe("");
  });

  it("ignores comment-only frames", () => {
    expect(parseSseChunk(": heartbeat\n\n").events).toEqual([]);
  });
});

describe("reconnect backoff", () => {
  it("doubles from 500ms up to a 15s cap with ±20% jitter", () => {
    expect(backoffDelay(0, () => 0.5)).toBe(500);
    expect(backoffDelay(1, () => 0.5)).toBe(1000);
    expect(backoffDelay(3, () => 0.5)).toBe(4000);
    expect(backoffDelay(10, () => 0.5)).toBe(15000);
    expect(backoffDelay(10, () => 0)).toBe(12000);
    expect(backoffDelay(10, () => 1)).toBe(18000);
  });

  it("reports reconnecting at first and offline after three failures", () => {
    expect(connectionStateAfterFailure(1)).toBe("reconnecting");
    expect(connectionStateAfterFailure(2)).toBe("reconnecting");
    expect(connectionStateAfterFailure(3)).toBe("offline");
  });
});
