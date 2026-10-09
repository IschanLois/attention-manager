#!/usr/bin/env node
// Claude Code hook forwarder: reads the hook payload from stdin, adds the terminal
// identity of the Claude process and POSTs it to the local receiver. It always exits 0
// so Claude Code is never blocked, never logs the payload, and keeps the token out of argv.
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { APP_NAME } from "../cli/meta.ts";
import { resolvePaths } from "../cli/paths.ts";
import { collectTerminal, linuxProcReader, psProcReader } from "./collect.ts";
import { minimizePayload } from "./minimize.ts";

const MAX_STDIN_BYTES = 1_048_576;
const DEFAULT_PORT = 4318;
const timeoutMs = Math.min(10, Math.max(0.2, Number(process.env.ATTENTION_HOOK_TIMEOUT) || 2)) * 1000;

setTimeout(() => process.exit(0), timeoutMs + 500).unref();

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    process.stdin.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_STDIN_BYTES) chunks.push(chunk);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

function readJson(file: string): unknown {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
}

function receiverUrl(configFile: string): string {
  if (process.env.ATTENTION_RECEIVER_URL) return process.env.ATTENTION_RECEIVER_URL.replace(/\/+$/, "");
  const envPort = Number(process.env.RECEIVER_PORT);
  const config = readJson(configFile) as { receiver?: { port?: unknown } } | null;
  const configPort = config?.receiver?.port;
  const port = Number.isInteger(envPort) && envPort > 0 ? envPort : Number.isInteger(configPort) ? (configPort as number) : DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

function readToken(tokenFile: string): string | null {
  if (process.env.ATTENTION_INGEST_TOKEN) return process.env.ATTENTION_INGEST_TOKEN.trim() || null;
  try {
    return readFileSync(tokenFile, "utf8").slice(0, 256).trim() || null;
  } catch {
    return null;
  }
}

function post(url: string, body: string, token: string | null): Promise<void> {
  return new Promise((resolve) => {
    const headers: Record<string, string | number> = { "content-type": "application/json", "content-length": Buffer.byteLength(body) };
    if (token) headers["x-attention-token"] = token;
    const req = request(`${url}/api/events`, { method: "POST", headers, timeout: timeoutMs }, (res) => {
      res.resume();
      res.on("end", () => resolve());
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve());
    req.end(body);
  });
}

async function main(): Promise<void> {
  const text = await readStdin();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return;
  }
  const minimized = minimizePayload(payload);
  if (minimized && typeof minimized === "object" && !Array.isArray(minimized)) {
    const cwd = (minimized as { cwd?: unknown }).cwd;
    (minimized as Record<string, unknown>).terminal = collectTerminal({
      platform: process.platform,
      env: process.env,
      parentPid: process.ppid,
      readProc: process.platform === "linux" ? linuxProcReader() : psProcReader(),
      cwd: typeof cwd === "string" ? cwd : undefined,
    });
  }
  const paths = resolvePaths({ platform: process.platform, env: process.env, home: homedir(), appName: APP_NAME });
  await post(receiverUrl(paths.configFile), JSON.stringify(minimized), readToken(paths.tokenFile));
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
