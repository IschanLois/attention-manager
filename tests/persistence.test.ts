import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeHookEvent } from "@/core/events/normalize";
import { openStore, type Store } from "@/core/persistence/store";
import { reduceSession } from "@/core/sessions/state-machine";
import type { NormalizedEvent } from "@/core/schemas";
import * as fx from "./fixtures/hook-events";

let clock = Date.parse("2026-10-09T08:00:00.000Z");
function ev(raw: unknown, advanceMs = 1000): NormalizedEvent {
  clock += advanceMs;
  const r = normalizeHookEvent(raw, new Date(clock).toISOString());
  if (!r.ok) throw new Error(r.reason);
  return r.event;
}

describe("store", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore({ path: ":memory:", eventHistoryLimit: 3 });
  });
  afterEach(() => store.close());

  it("round-trips a session record including classification fields", () => {
    const e = ev(fx.permissionRequest());
    const session = { ...reduceSession(null, e), classificationEvidence: ["a", "b"], classificationConfidence: 0.5, classifiedAt: e.receivedAt };
    store.upsertSession(session);
    expect(store.getSession(session.sessionId)).toEqual(session);
    expect(store.listSessions()).toEqual([session]);
  });

  it("updates an existing session in place", () => {
    const first = reduceSession(null, ev(fx.sessionStart()));
    store.upsertSession(first);
    const second = reduceSession(first, ev(fx.userPromptSubmit()));
    store.upsertSession(second);
    expect(store.listSessions()).toHaveLength(1);
    expect(store.getSession(fx.SESSION_A)?.status).toBe("working");
  });

  it("stores events and returns them newest first, bounded by the history limit", () => {
    const events = [fx.sessionStart(), fx.userPromptSubmit(), fx.preToolUse(), fx.postToolUse(), fx.stop()].map((r) => ev(r));
    for (const e of events) store.insertEvent(e);
    const stored = store.listEvents(fx.SESSION_A);
    expect(stored.map((s: { eventType: string }) => s.eventType)).toEqual(["turn_complete", "tool_end", "tool_start"]);
    expect(stored[0]!.summary).toBe("Turn finished");
    expect(stored[0]!.receivedAt).toBe(events[4]!.receivedAt);
  });

  it("prunes old events per session so storage stays bounded", () => {
    for (let i = 0; i < 10; i++) store.insertEvent(ev(fx.preToolUse(fx.SESSION_A, `t${i}`)));
    for (let i = 0; i < 2; i++) store.insertEvent(ev(fx.preToolUse(fx.SESSION_B, `u${i}`)));
    expect(store.countEvents(fx.SESSION_A)).toBe(3);
    expect(store.countEvents(fx.SESSION_B)).toBe(2);
  });

  it("detects duplicate events by dedupe key within a window", () => {
    const e = ev(fx.permissionRequest());
    expect(store.hasRecentEvent(e.dedupeKey, Date.parse(e.receivedAt), 60_000)).toBe(false);
    store.insertEvent(e);
    expect(store.hasRecentEvent(e.dedupeKey, Date.parse(e.receivedAt) + 10_000, 60_000)).toBe(true);
    expect(store.hasRecentEvent(e.dedupeKey, Date.parse(e.receivedAt) + 120_000, 60_000)).toBe(false);
  });

  it("recovers sessions after reopening a file-backed database", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "attention-store-"));
    const path = join(dir, "test.db");
    try {
      const a = openStore({ path, eventHistoryLimit: 5 });
      const session = reduceSession(null, ev(fx.permissionRequest()));
      a.upsertSession(session);
      a.insertEvent(ev(fx.permissionRequest()));
      a.close();
      const b = openStore({ path, eventHistoryLimit: 5 });
      expect(b.getSession(fx.SESSION_B)).toEqual(session);
      expect(b.listEvents(fx.SESSION_B)).toHaveLength(1);
      b.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates the parent directory for the database file", async () => {
    const { mkdtemp, rm, stat } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "attention-store-"));
    try {
      const s = openStore({ path: join(dir, "nested", "deeper", "x.db"), eventHistoryLimit: 5 });
      s.close();
      expect((await stat(join(dir, "nested", "deeper", "x.db"))).isFile()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
