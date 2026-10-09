import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME } from "./meta.ts";
import { ensurePrivateDir } from "./paths.ts";

export type Probe = { state: "ours"; sseClients: number } | { state: "absent" } | { state: "foreign"; detail: string };

export class LifecycleError extends Error {
  readonly exitCode: 1 | 2;

  constructor(message: string, exitCode: 1 | 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

export async function probeReceiver(baseUrl: string, timeoutMs = 1000): Promise<Probe> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EADDRNOTAVAIL") return { state: "absent" };
    return { state: "foreign", detail: (error as Error).message };
  }
  try {
    const body = (await res.json()) as { app?: unknown; receiver?: { sseClients?: unknown }; sqlite?: unknown };
    const looksLikeOurs = res.ok && (body.app === APP_NAME || (body.receiver !== undefined && body.sqlite !== undefined));
    if (looksLikeOurs) return { state: "ours", sseClients: Number(body.receiver?.sseClients ?? 0) };
  } catch {
    // not JSON: some other server owns the port
  }
  return { state: "foreign", detail: `HTTP ${res.status}` };
}

export interface SpawnedReceiver {
  exited(): number | null;
}

export interface EnsureOptions {
  port: number;
  probe: () => Promise<Probe>;
  spawn: () => SpawnedReceiver;
  pollMs?: number;
  waitMs?: number;
  logFile?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function conflict(port: number, detail: string): LifecycleError {
  return new LifecycleError(
    `Port ${port} is in use by another program (${detail}). Free it, or pick another port with RECEIVER_PORT or "receiver.port" in the config file.`,
    2,
  );
}

export async function ensureReceiver(options: EnsureOptions): Promise<{ startedByUs: boolean }> {
  const { port, probe, pollMs = 150, waitMs = 6000, logFile } = options;
  const first = await probe();
  if (first.state === "ours") return { startedByUs: false };
  if (first.state === "foreign") throw conflict(port, first.detail);

  const child = options.spawn();
  const logHint = logFile ? ` See ${logFile}.` : "";
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const code = child.exited();
    if (code !== null) throw new LifecycleError(`The receiver exited with code ${code} during startup.${logHint}`, 1);
    const next = await probe();
    if (next.state === "ours") return { startedByUs: true };
    if (next.state === "foreign") throw conflict(port, next.detail);
  }
  throw new LifecycleError(`The receiver did not become ready within ${Math.round(waitMs / 1000)}s.${logHint}`, 1);
}

export function cliEntry(): string {
  const own = fileURLToPath(import.meta.url);
  return own.replace(/lifecycle\.(ts|js)$/, "main.$1");
}

export function spawnDetachedReceiver(options: { logFile: string; env: Record<string, string | undefined>; exitWhenIdle: boolean }): SpawnedReceiver {
  ensurePrivateDir(dirname(options.logFile));
  const log = openSync(options.logFile, "a", 0o600);
  const args = [cliEntry(), "receiver", ...(options.exitWhenIdle ? ["--exit-when-idle"] : [])];
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", log, log], env: options.env as NodeJS.ProcessEnv });
  closeSync(log);
  let exitCode: number | null = null;
  child.on("exit", (code, signal) => {
    exitCode = code ?? (signal ? 128 : 1);
  });
  child.on("error", () => {
    exitCode = 1;
  });
  child.unref();
  return { exited: () => exitCode };
}
