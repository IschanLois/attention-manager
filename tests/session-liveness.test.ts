import { describe, expect, it } from "vitest";
import { exitedSessionIds, type ProcessProbe } from "@/receiver/liveness";
import type { Session } from "@/core/schemas";
import { FIXTURE_NOW, minutesAgo, sessionView } from "./fixtures/sessions";

const STALE_MS = 600_000;

function session(id: string, overrides: Partial<Session> = {}): Session {
  const { stale: _stale, ...rest } = sessionView({ sessionId: id, status: "starting", ...overrides });
  return rest;
}

function probe(processes: Record<number, string | null>, detached: number[] = []): ProcessProbe {
  return (pid) => (pid in processes ? { alive: true, name: processes[pid]!, detached: detached.includes(pid) } : { alive: false, name: null });
}

const check = (sessions: Session[], processes: Record<number, string | null>, detached: number[] = []) =>
  exitedSessionIds(sessions, probe(processes, detached), FIXTURE_NOW, STALE_MS);

describe("exitedSessionIds", () => {
  it("reports open sessions whose Claude process is gone and keeps the running ones", () => {
    const sessions = [
      session("gone", { terminal: { pid: 300, processName: "claude" } }),
      session("running", { terminal: { pid: 301, processName: "claude" } }),
    ];
    expect(check(sessions, { 301: "claude" })).toEqual(["gone"]);
  });

  it("reports a session whose pid now belongs to a different program", () => {
    expect(check([session("reused", { terminal: { pid: 300, processName: "claude" } })], { 300: "bash" })).toEqual(["reused"]);
  });

  it("reports a running Claude process whose terminal was closed under it", () => {
    const sessions = [
      session("orphan", { terminal: { pid: 300, processName: "claude" } }),
      session("attached", { terminal: { pid: 301, processName: "claude" } }),
    ];
    expect(check(sessions, { 300: "claude", 301: "claude" }, [300])).toEqual(["orphan"]);
  });

  it("keeps a session when the running process name cannot be read", () => {
    expect(check([session("unknown-name", { terminal: { pid: 300, processName: "claude" } })], { 300: null })).toEqual([]);
  });

  it("never trusts a pid that was not recorded as the Claude process", () => {
    expect(check([session("wrapper", { terminal: { pid: 300, processName: "node" } })], {})).toEqual([]);
  });

  it("ends sessions from older hooks only when the process is gone and the session is stale", () => {
    const sessions = [
      session("old-stale", { terminal: { pid: 300 }, lastSeenAt: minutesAgo(30) }),
      session("old-fresh", { terminal: { pid: 301 }, lastSeenAt: minutesAgo(1) }),
    ];
    expect(check(sessions, {})).toEqual(["old-stale"]);
  });

  it("ignores ended sessions and sessions without a pid", () => {
    const sessions = [
      session("ended", { status: "ended", terminal: { pid: 300, processName: "claude" } }),
      session("no-pid", { terminal: { tty: "/dev/pts/4" } }),
      session("no-terminal", { terminal: null }),
    ];
    expect(check(sessions, {})).toEqual([]);
  });
});
