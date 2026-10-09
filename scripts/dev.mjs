// Runs the receiver and the Next.js dashboard together for local development.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../..");
const common = { cwd: root, stdio: "inherit", env: { NEXT_TELEMETRY_DISABLED: "1", ...process.env } };

const receiver = spawn(
  process.execPath,
  ["--env-file-if-exists=.env", "--no-warnings=ExperimentalWarning", "src/receiver/main.ts"],
  common,
);
// Next.js loads .env files itself and rejects --env-file in its child process options.
const dashboard = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "dev", "-H", "127.0.0.1"],
  common,
);

const children = [receiver, dashboard];
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500).unref();
}

for (const child of children) {
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`[dev] a process exited with code ${code ?? "null"}; stopping the other.`);
      shutdown(code ?? 1);
    }
  });
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
