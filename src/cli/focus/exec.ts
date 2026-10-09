import { execFile } from "node:child_process";
import type { Exec } from "./types.ts";

export const FOCUS_TIMEOUT_MS = 1500;

export const execFocusCommand: Exec = (file, args, options = {}) => {
  const timeoutMs = options.timeoutMs ?? FOCUS_TIMEOUT_MS;
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) return resolve({ ok: true, stdout });
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return resolve({ ok: false, kind: "missing", message: `${file} is not installed` });
      if ((error as { killed?: boolean }).killed) return resolve({ ok: false, kind: "timeout", message: `${file} timed out after ${timeoutMs}ms` });
      const detail = String(stderr || stdout || error.message).trim().split("\n")[0]!.slice(0, 200);
      resolve({ ok: false, kind: "exit", message: `${file} failed: ${detail}` });
    });
  });
};
