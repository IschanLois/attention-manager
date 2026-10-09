import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_HOOK_EVENTS } from "../core/schemas.ts";
import { ensurePrivateDir, type AppPaths } from "./paths.ts";

export const HOOK_EVENTS = SUPPORTED_HOOK_EVENTS;
const HOOK_TIMEOUT_SECONDS = 5;

interface CommandHook {
  type: string;
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: CommandHook[];
}

export type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

export interface HookCommandSpec {
  nodePath: string;
  hookScript: string;
}

const UNSAFE_IN_QUOTES = /["$`\\\n\r]/;
const OUR_HOOK = /(?:^|[/"])(?:dist\/hook\/main\.js|src\/hook\/main\.ts|scripts\/claude-hook\.sh)"?\s*$/;

export function defaultHookSpec(): HookCommandSpec {
  const ownFile = fileURLToPath(import.meta.url);
  const entry = ownFile.endsWith(".ts") ? "main.ts" : "main.js";
  return { nodePath: process.execPath, hookScript: join(dirname(ownFile), "..", "hook", entry) };
}

export function defaultSettingsPath(env: Record<string, string | undefined> = process.env): string {
  return env.CLAUDE_SETTINGS_PATH || join(homedir(), ".claude", "settings.json");
}

export function hookCommand({ nodePath, hookScript }: HookCommandSpec): string {
  for (const path of [nodePath, hookScript]) {
    if (UNSAFE_IN_QUOTES.test(path)) throw new Error(`refusing to write a hook command for an unsafe path: ${path}`);
  }
  return `"${nodePath}" "${hookScript}"`;
}

export function hookScriptOf(command: string): string | null {
  const quoted = [...command.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  if (quoted.length > 0) return quoted.at(-1)!;
  return command.trim().split(/\s+/).at(-1) ?? null;
}

export function isOurHook(command: string): boolean {
  return OUR_HOOK.test(command);
}

function isOurs(hook: CommandHook): boolean {
  return hook.type === "command" && typeof hook.command === "string" && isOurHook(hook.command);
}

function eventsWithOurs(hooks: Settings["hooks"]): string[] {
  const found = Object.entries(hooks ?? {})
    .filter(([, groups]) => Array.isArray(groups) && groups.some((g) => (g.hooks ?? []).some(isOurs)))
    .map(([event]) => event);
  const known: string[] = HOOK_EVENTS.filter((e) => found.includes(e));
  return [...known, ...found.filter((e) => !known.includes(e))];
}

function withoutOurHooks(hooks: Settings["hooks"]): Record<string, HookGroup[]> {
  const result: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((group) => {
        const original = group.hooks ?? [];
        const remaining = original.filter((h) => !isOurs(h));
        const emptiedByUs = remaining.length === 0 && original.length > 0;
        return emptiedByUs ? null : { ...group, hooks: remaining };
      })
      .filter((group): group is HookGroup => group !== null);
    if (kept.length > 0) result[event] = kept;
  }
  return result;
}

export interface InstallPlan {
  settings: Settings;
  added: string[];
  replaced: string[];
  unchanged: boolean;
}

export function planInstall(settings: Settings, command: string): InstallPlan {
  const previous = new Set(eventsWithOurs(settings.hooks));
  const hooks = withoutOurHooks(settings.hooks);
  for (const event of HOOK_EVENTS) {
    hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] }];
  }
  const next: Settings = { ...settings, hooks };
  return {
    settings: next,
    added: HOOK_EVENTS.filter((e) => !previous.has(e)),
    replaced: HOOK_EVENTS.filter((e) => previous.has(e)),
    unchanged: JSON.stringify(next) === JSON.stringify(settings),
  };
}

export function planUninstall(settings: Settings): { settings: Settings; removed: string[] } {
  const removed = eventsWithOurs(settings.hooks);
  const hooks = withoutOurHooks(settings.hooks);
  const next: Settings = { ...settings };
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return { settings: next, removed };
}

export type HookState = "installed" | "partial" | "stale" | "absent";

export interface HookStatus {
  state: HookState;
  events: string[];
  commands: string[];
  reason: string | null;
}

export function hookStatus(settings: Settings, expectedCommand: string, fileExists: (path: string) => boolean = existsSync): HookStatus {
  const events = eventsWithOurs(settings.hooks);
  const commands = [
    ...new Set(
      Object.values(settings.hooks ?? {})
        .flatMap((groups) => (Array.isArray(groups) ? groups : []))
        .flatMap((g) => g.hooks ?? [])
        .filter(isOurs)
        .map((h) => h.command),
    ),
  ];
  if (events.length === 0) return { state: "absent", events, commands, reason: null };
  const foreign = commands.find((c) => c !== expectedCommand);
  if (foreign) return { state: "stale", events, commands, reason: `hooks point to a different install (${foreign}); re-run hooks install` };
  const missing = commands.map(hookScriptOf).find((script) => script !== null && !fileExists(script));
  if (missing) return { state: "stale", events, commands, reason: `hook entry is missing on disk (${missing}); re-run hooks install` };
  if (events.length < HOOK_EVENTS.length) {
    return { state: "partial", events, commands, reason: `installed for ${events.length} of ${HOOK_EVENTS.length} events` };
  }
  return { state: "installed", events, commands, reason: null };
}

export function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  const parsed: unknown = text.trim() ? JSON.parse(text) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed as Settings;
}

export function writeSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  const backupPath = `${path}.attention-backup`;
  if (existsSync(path) && !existsSync(backupPath)) copyFileSync(path, backupPath);
  const tmpPath = `${path}.attention-tmp`;
  writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmpPath, path);
}

export function ensureToken(paths: Pick<AppPaths, "tokenFile" | "headerFile">): { token: string; created: boolean } {
  ensurePrivateDir(dirname(paths.tokenFile));
  const existing = existsSync(paths.tokenFile) ? readFileSync(paths.tokenFile, "utf8").trim() : "";
  const token = existing || randomBytes(24).toString("base64url");
  for (const [file, content] of [
    [paths.tokenFile, token + "\n"],
    [paths.headerFile, `x-attention-token: ${token}\n`],
  ] as const) {
    writeFileSync(file, content, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return { token, created: !existing };
}
