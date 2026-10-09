import { readFileSync, readlinkSync } from "node:fs";
import type { Session } from "../core/schemas.ts";
import { isStale } from "../core/sessions/state-machine.ts";

export type ProcessProbe = (pid: number) => { alive: boolean; name: string | null; detached?: boolean };

const CLAUDE = /claude/i;

// Closing a terminal tab can leave Claude running without a terminal: it is orphaned
// and stopped, and its pty is deleted. Only /proc exposes this, so macOS never reports it.
function hasLostTerminal(pid: number): boolean {
  try {
    return readlinkSync(`/proc/${pid}/fd/0`).endsWith(" (deleted)");
  } catch {
    return false;
  }
}

export function probeProcess(pid: number): ReturnType<ProcessProbe> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return { alive: false, name: null };
  }
  try {
    return { alive: true, name: readFileSync(`/proc/${pid}/comm`, "utf8").trim(), detached: hasLostTerminal(pid) };
  } catch {
    return { alive: true, name: null };
  }
}

// A missing SessionEnd (exit right after /clear, a closed tab, a crash) would leave a
// session open forever, so open sessions are checked against their Claude process.
// Only a pid recorded as the Claude process is trusted; sessions from older hooks,
// which did not record the process name, must also be stale.
export function exitedSessionIds(sessions: Session[], probe: ProcessProbe, nowMs: number, staleAfterMs: number): string[] {
  return sessions
    .filter((session) => {
      const pid = session.terminal?.pid;
      if (session.status === "ended" || !pid) return false;
      const recorded = session.terminal?.processName;
      if (recorded !== undefined && !CLAUDE.test(recorded)) return false;
      const running = probe(pid);
      const gone = !running.alive || running.detached === true;
      if (recorded === undefined) return gone && isStale(session, nowMs, staleAfterMs);
      return gone || (running.name !== null && running.name !== recorded);
    })
    .map((session) => session.sessionId);
}
