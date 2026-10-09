import { existsSync, readFileSync } from "node:fs";
import { sanitizeTerminal } from "../core/terminal.ts";
import { collectTerminal, linuxProcReader, psProcReader } from "../hook/collect.ts";
import { EXIT_ERROR, EXIT_MISCONFIGURED, EXIT_OK } from "./args.ts";
import { createClient } from "./client.ts";
import { focusContext, type CliContext } from "./context.ts";
import { planFocus } from "./focus/select.ts";
import { isWayland } from "./focus/types.ts";
import { hookCommand, hookStatus, readSettings, type HookStatus } from "./hooks.ts";
import type { HealthReport, SessionView } from "./model/types.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
  // A failed check either means the setup is wrong (exit 2) or something is broken (exit 1).
  misconfiguration?: boolean;
}

export interface DoctorInputs {
  platform: string;
  configError: string | null;
  tokenPresent: boolean;
  hooks: HookStatus | { state: "error"; reason: string };
  classifierEnabled: boolean;
  model: string;
  health: HealthReport | null;
  directModel: { reachable: boolean; modelInstalled: boolean } | null;
  ingestStatus: number | null;
  currentTerminal: { backends: string[]; wayland: boolean };
  sessions: SessionView[] | null;
  focusable(session: SessionView): boolean;
}

function modelCheck(inputs: DoctorInputs): Check {
  const label = "local model";
  if (!inputs.classifierEnabled) return { id: "model", label, status: "ok", detail: "disabled in config; rule-based classification only" };
  const model = inputs.health?.model ?? inputs.directModel;
  if (!model) return { id: "model", label, status: "warn", detail: "not checked" };
  if (!model.reachable) return { id: "model", label, status: "warn", detail: "Ollama is unreachable; running rule-based only", hint: "start Ollama (ollama serve) or disable local AI in `attention setup`" };
  if (!model.modelInstalled) return { id: "model", label, status: "warn", detail: `${inputs.model} is not installed; running rule-based only`, hint: `ollama pull ${inputs.model}` };
  return { id: "model", label, status: "ok", detail: `${inputs.model} available` };
}

function terminalCheck(inputs: DoctorInputs): Check {
  const { backends, wayland } = inputs.currentTerminal;
  const automation = backends.some((b) => b === "iterm" || b === "apple-terminal")
    ? "macOS asks once for Automation permission the first time a session is focused (System Settings → Privacy & Security → Automation)."
    : undefined;
  if (backends.length > 0) return { id: "terminal", label: "terminal focus", status: "ok", detail: `this shell can be focused via ${backends.join(" + ")}`, hint: automation };
  const detail = wayland
    ? "no focus route for this shell. Wayland has no generic window-focus API; use tmux, screen, kitty (allow_remote_control) or WezTerm, or run sway/Hyprland."
    : "no focus route for this shell; sessions will show a manual hint instead";
  return { id: "terminal", label: "terminal focus", status: "warn", detail, hint: inputs.platform === "linux" && !wayland ? "install xdotool or wmctrl, or run Claude inside tmux" : undefined };
}

export function doctorChecks(inputs: DoctorInputs): Check[] {
  const checks: Check[] = [];
  checks.push(
    inputs.configError
      ? { id: "config", label: "config", status: "fail", detail: inputs.configError, hint: "fix or delete the file, then run `attention setup`", misconfiguration: true }
      : { id: "config", label: "config", status: "ok", detail: "valid" },
  );
  checks.push(
    inputs.tokenPresent
      ? { id: "token", label: "ingest token", status: "ok", detail: "present" }
      : { id: "token", label: "ingest token", status: "fail", detail: "missing", hint: "run `attention setup` or `attention hooks install`", misconfiguration: true },
  );

  const hooks = inputs.hooks;
  if (hooks.state === "installed") checks.push({ id: "hooks", label: "Claude Code hooks", status: "ok", detail: `installed for ${hooks.events.length} events` });
  else if (hooks.state === "partial") checks.push({ id: "hooks", label: "Claude Code hooks", status: "warn", detail: hooks.reason ?? "partially installed", hint: "attention hooks install" });
  else {
    const detail = hooks.state === "absent" ? "not installed" : hooks.state === "stale" ? `stale: ${hooks.reason}` : `cannot read settings: ${hooks.reason}`;
    checks.push({ id: "hooks", label: "Claude Code hooks", status: "fail", detail, hint: "attention hooks install", misconfiguration: true });
  }

  const health = inputs.health;
  if (!health) {
    checks.push({ id: "receiver", label: "receiver", status: "warn", detail: "not running; `attention` starts it on demand", hint: "attention receiver" });
  } else {
    checks.push({ id: "receiver", label: "receiver", status: "ok", detail: `running v${health.version}, ${health.sessionCount} session(s), up ${health.uptimeSeconds}s` });
    checks.push(
      health.sqlite.ok
        ? { id: "sqlite", label: "database", status: "ok", detail: health.sqlite.path }
        : { id: "sqlite", label: "database", status: "fail", detail: `${health.sqlite.error ?? "error"}; running in memory` },
    );
  }
  checks.push(modelCheck(inputs));

  if (inputs.ingestStatus !== null) {
    if (inputs.ingestStatus === 200) checks.push({ id: "ingest", label: "hook ingestion", status: "ok", detail: "receiver accepts authenticated events" });
    else if (inputs.ingestStatus === 401) {
      checks.push({ id: "ingest", label: "hook ingestion", status: "fail", detail: "token rejected", hint: "the receiver was started with another token; restart it" });
    } else checks.push({ id: "ingest", label: "hook ingestion", status: "fail", detail: `unexpected status ${inputs.ingestStatus}` });
  }

  checks.push(terminalCheck(inputs));
  if (inputs.sessions) {
    const active = inputs.sessions.filter((s) => s.status !== "ended");
    const focusable = active.filter(inputs.focusable).length;
    checks.push({ id: "sessions", label: "sessions", status: "ok", detail: `${focusable} of ${active.length} sessions can be focused` });
  }
  return checks;
}

export function doctorExitCode(checks: Check[]): number {
  const failed = checks.filter((c) => c.status === "fail");
  if (failed.some((c) => c.misconfiguration)) return EXIT_MISCONFIGURED;
  return failed.length ? EXIT_ERROR : EXIT_OK;
}

async function getJson(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export function currentShellTerminal(ctx: CliContext) {
  return sanitizeTerminal(
    collectTerminal({ platform: ctx.platform, env: ctx.env, parentPid: process.pid, readProc: ctx.platform === "linux" ? linuxProcReader() : psProcReader(), cwd: process.cwd() }),
  );
}

export async function gatherDoctorInputs(ctx: CliContext): Promise<DoctorInputs> {
  let hooks: DoctorInputs["hooks"];
  try {
    hooks = hookStatus(readSettings(ctx.settingsPath), hookCommand(ctx.hookSpec));
  } catch (error) {
    hooks = { state: "error", reason: (error as Error).message };
  }
  const client = createClient(ctx.receiverUrl);
  const health = await client.health().catch(() => null);
  let directModel: DoctorInputs["directModel"] = null;
  if (!health && ctx.config.classifier.enabled) {
    const tags = (await getJson(`${ctx.config.classifier.ollamaUrl}/api/tags`)) as { models?: Array<{ name?: string }> } | null;
    directModel = { reachable: tags !== null, modelInstalled: Boolean(tags?.models?.some((m) => m.name === ctx.config.classifier.model)) };
  }
  let ingestStatus: number | null = null;
  if (health) {
    const token = existsSync(ctx.paths.tokenFile) ? readFileSync(ctx.paths.tokenFile, "utf8").trim() : "";
    ingestStatus = await fetch(`${ctx.receiverUrl}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-attention-token": token },
      body: JSON.stringify({ hook_event_name: "InstructionsLoaded", session_id: "doctor-probe-0000" }),
      signal: AbortSignal.timeout(3000),
    })
      .then((r) => r.status)
      .catch(() => 0);
  }
  const focus = focusContext(ctx);
  const shell = currentShellTerminal(ctx);
  const sessions = health ? await client.sessions().then((s) => s.sessions).catch(() => null) : null;
  return {
    platform: ctx.platform,
    configError: ctx.configError ?? null,
    tokenPresent: existsSync(ctx.paths.tokenFile),
    hooks,
    classifierEnabled: ctx.config.classifier.enabled,
    model: ctx.config.classifier.model,
    health,
    directModel,
    ingestStatus,
    currentTerminal: { backends: planFocus(shell, focus).map((a) => a.id), wayland: ctx.platform === "linux" && isWayland(ctx.env) },
    sessions,
    focusable: (s) => planFocus(s.terminal, focus).length > 0,
  };
}

const MARK: Record<CheckStatus, string> = { ok: "OK  ", warn: "WARN", fail: "FAIL" };

export async function runDoctor(ctx: CliContext, json: boolean): Promise<number> {
  const checks = doctorChecks(await gatherDoctorInputs(ctx));
  const exitCode = doctorExitCode(checks);
  if (json) {
    ctx.out(JSON.stringify({ version: 1, exitCode, receiver: ctx.receiverUrl, paths: ctx.paths, checks }, null, 2));
    return exitCode;
  }
  ctx.out(`attention doctor (receiver ${ctx.receiverUrl})`);
  ctx.out(`config ${ctx.paths.configFile}`);
  ctx.out(`state  ${ctx.paths.stateDir}\n`);
  for (const check of checks) {
    ctx.out(`${MARK[check.status]} ${check.label.padEnd(18)} ${check.detail}`);
    if (check.hint && check.status !== "ok") ctx.out(`     ${"".padEnd(18)} → ${check.hint}`);
    else if (check.hint) ctx.out(`     ${"".padEnd(18)}   ${check.hint}`);
  }
  ctx.out(exitCode === EXIT_OK ? "\nNo problems found." : exitCode === EXIT_MISCONFIGURED ? "\nSetup is incomplete; follow the hints above." : "\nSomething is broken; see the failures above.");
  return exitCode;
}
