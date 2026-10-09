import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionEnd",
] as const;

interface CommandHook {
  type: "command";
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: CommandHook[];
}

type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hookScript = join(projectRoot, "scripts", "claude-hook.sh");
const tokenPath = resolve(projectRoot, process.env.INGEST_TOKEN_PATH ?? "data/ingest-token");
const headerPath = join(dirname(tokenPath), "ingest-header");
const settingsPath = process.env.CLAUDE_SETTINGS_PATH ?? join(homedir(), ".claude", "settings.json");

function readSettings(): Settings {
  if (!existsSync(settingsPath)) return {};
  const text = readFileSync(settingsPath, "utf8");
  const parsed: unknown = text.trim() ? JSON.parse(text) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${settingsPath} is not a JSON object`);
  return parsed as Settings;
}

function isOurs(hook: CommandHook): boolean {
  return hook.type === "command" && hook.command.includes("claude-hook.sh");
}

function withoutOurHooks(hooks: Record<string, HookGroup[]> | undefined): Record<string, HookGroup[]> {
  const result: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    const kept = groups
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length > 0) result[event] = kept;
  }
  return result;
}

function writeSettings(settings: Settings): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.attention-backup`);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

function ensureToken(): string {
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  const token = existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : randomBytes(24).toString("base64url");
  writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  writeFileSync(headerPath, `x-attention-token: ${token}\n`, { mode: 0o600 });
  chmodSync(headerPath, 0o600);
  return token;
}

function install(): void {
  ensureToken();
  chmodSync(hookScript, 0o755);
  const settings = readSettings();
  const hooks = withoutOurHooks(settings.hooks);
  for (const event of HOOK_EVENTS) {
    const group: HookGroup = { hooks: [{ type: "command", command: hookScript, timeout: 5 }] };
    hooks[event] = [...(hooks[event] ?? []), group];
  }
  writeSettings({ ...settings, hooks });
  console.log(`Installed attention-manager hooks for ${HOOK_EVENTS.length} events in ${settingsPath}`);
  console.log(`Ingest token: ${tokenPath} and ${headerPath} (mode 0600)`);
  console.log(`Backup of previous settings: ${settingsPath}.attention-backup`);
  console.log("Restart running Claude Code sessions to pick up the hooks.");
}

function uninstall(): void {
  const settings = readSettings();
  const hooks = withoutOurHooks(settings.hooks);
  const next: Settings = { ...settings };
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  writeSettings(next);
  console.log(`Removed attention-manager hooks from ${settingsPath}`);
}

function status(): void {
  const settings = readSettings();
  const installed = Object.entries(settings.hooks ?? {})
    .filter(([, groups]) => groups.some((g) => (g.hooks ?? []).some(isOurs)))
    .map(([event]) => event);
  console.log(`Settings file: ${settingsPath}`);
  console.log(`Hook script:   ${hookScript}`);
  console.log(`Token file:    ${tokenPath} (${existsSync(tokenPath) ? "present" : "missing"})`);
  console.log(`Installed for: ${installed.length ? installed.join(", ") : "none"}`);
}

const command = process.argv[2] ?? "status";
if (command === "install") install();
else if (command === "uninstall") uninstall();
else if (command === "status") status();
else {
  console.error("usage: setup-hooks.ts <install|uninstall|status>");
  process.exit(1);
}
