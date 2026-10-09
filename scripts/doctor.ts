// Diagnostics: receiver availability, hook installation, SQLite, model connectivity.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/receiver/config.ts";

const config = loadConfig();
const settingsPath = process.env.CLAUDE_SETTINGS_PATH ?? join(homedir(), ".claude", "settings.json");
const receiverUrl = process.env.RECEIVER_URL ?? `http://127.0.0.1:${config.port}`;
let failures = 0;

function report(ok: boolean, label: string, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label.padEnd(22)} ${detail}`);
}

async function getJson(url: string, timeoutMs = 3000): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hooksInstalled(): { installed: string[]; error: string | null } {
  if (!existsSync(settingsPath)) return { installed: [], error: `${settingsPath} not found` };
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
    const installed = Object.entries(settings.hooks ?? {})
      .filter(([, groups]) => groups.some((g) => (g.hooks ?? []).some((h) => (h.command ?? "").includes("claude-hook.sh"))))
      .map(([event]) => event);
    return { installed, error: null };
  } catch (error) {
    return { installed: [], error: (error as Error).message };
  }
}

console.log(`Attention Manager doctor (receiver ${receiverUrl}, model ${config.ollamaModel} at ${config.ollamaUrl})\n`);

const health = await getJson(`${receiverUrl}/api/health`);
report(health !== null, "receiver", health ? `reachable, ${String(health.sessionCount)} session(s), uptime ${String(health.uptimeSeconds)}s` : "not reachable; start it with `pnpm receiver`");

const hooks = hooksInstalled();
report(hooks.installed.length >= 5, "hooks", hooks.error ?? (hooks.installed.length ? `installed for ${hooks.installed.join(", ")}` : "not installed; run `pnpm hooks:install`"));
report(config.ingestToken !== null, "ingest token", config.ingestToken ? `present at ${config.tokenPath}` : `missing at ${config.tokenPath}; run \`pnpm hooks:install\``);

if (health) {
  const sqlite = health.sqlite as { ok: boolean; path: string; error: string | null };
  report(sqlite.ok, "sqlite", sqlite.ok ? sqlite.path : `${sqlite.error ?? "error"} (running in memory)`);
  const model = health.model as { reachable: boolean; modelInstalled: boolean; error: string | null };
  report(model.reachable, "model runtime", model.reachable ? "reachable" : `unreachable (${model.error ?? "no detail"}); rule-based classification only`);
  report(model.modelInstalled, "model", model.modelInstalled ? `${config.ollamaModel} installed` : `${config.ollamaModel} not installed; run \`ollama pull ${config.ollamaModel}\``);
  const lastEvent = health.lastEventAt as string | null;
  report(true, "last event", lastEvent ?? "none since start");
  const lastError = health.lastClassificationError as { message: string; at: string } | null;
  report(true, "last classify error", lastError ? `${lastError.message} at ${lastError.at}` : "none");
} else {
  const tags = await getJson(`${config.ollamaUrl}/api/tags`);
  report(tags !== null, "model runtime", tags ? "reachable (checked directly)" : "unreachable; rule-based classification only");
  report(existsSync(config.databasePath) || config.databasePath === ":memory:", "sqlite", existsSync(config.databasePath) ? `${config.databasePath} exists` : "database not created yet");
}

if (health) {
  const ingest = await fetch(`${receiverUrl}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-attention-token": config.ingestToken ?? "" },
    body: JSON.stringify({ hook_event_name: "InstructionsLoaded", session_id: "doctor-probe-0000" }),
    signal: AbortSignal.timeout(3000),
  }).then((r) => r.status).catch(() => 0);
  report(ingest === 200, "hook ingestion", ingest === 200 ? "receiver accepts authenticated events" : ingest === 401 ? "token rejected; re-run `pnpm hooks:install` and restart the receiver" : `unexpected status ${ingest}`);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
