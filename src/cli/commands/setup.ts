import * as clack from "@clack/prompts";
import { EXIT_ERROR, EXIT_OK } from "../args.ts";
import { loadCliConfig, saveCliConfig } from "../config.ts";
import { focusContext, type CliContext } from "../context.ts";
import { currentShellTerminal } from "../doctor.ts";
import { focusSession, planFocus } from "../focus/select.ts";
import { isWayland } from "../focus/types.ts";
import { ensureToken, hookCommand, planInstall, readSettings } from "../hooks.ts";
import { runSetup, type Prompter } from "../setup.ts";
import { installHooks } from "./hooks.ts";

function clackPrompter(): Prompter {
  const orNull = <T>(value: T): Exclude<T, symbol> | null => (clack.isCancel(value) ? null : (value as Exclude<T, symbol>));
  return {
    intro: (text) => clack.intro(text),
    note: (text, title) => clack.note(text, title),
    info: (text) => clack.log.info(text),
    warn: (text) => clack.log.warn(text),
    success: (text) => clack.log.success(text),
    outro: (text) => clack.outro(text),
    confirm: async (message, initial) => orNull(await clack.confirm({ message, initialValue: initial })),
    select: async (message, options, initial) => orNull(await clack.select({ message, options, initialValue: initial })),
    text: async (message, initial, validate) =>
      orNull(await clack.text({ message, initialValue: initial, placeholder: initial, validate: validate ? (v) => validate(v ?? "") : undefined })),
  };
}

// Non-interactive runs (--yes, CI) print plain lines instead of drawing prompts.
function plainPrompter(ctx: CliContext): Prompter {
  const unexpected = async (): Promise<null> => {
    throw new Error("setup needs answers; pass --yes to accept the defaults");
  };
  return {
    intro: (text) => ctx.out(text),
    note: (text, title) => ctx.out(title ? `${title}: ${text}` : text),
    info: (text) => ctx.out(text),
    warn: (text) => ctx.out(`warning: ${text}`),
    success: (text) => ctx.out(text),
    outro: (text) => ctx.out(text),
    confirm: unexpected,
    select: unexpected,
    text: unexpected,
  };
}

async function probeOllama(url: string, model: string): Promise<{ reachable: boolean; modelInstalled: boolean }> {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { reachable: false, modelInstalled: false };
    const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    const names = (body.models ?? []).flatMap((m) => [m.name, m.model]).filter(Boolean);
    return { reachable: true, modelInstalled: names.includes(model) || names.includes(`${model}:latest`) };
  } catch {
    return { reachable: false, modelInstalled: false };
  }
}

export function reloadContext(ctx: CliContext): CliContext {
  const loaded = loadCliConfig(ctx.paths.configFile);
  return loaded.ok ? { ...ctx, config: loaded.config, configExists: loaded.exists, configError: undefined } : ctx;
}

export async function runSetupCommand(ctx: CliContext, options: { yes: boolean }): Promise<number> {
  const interactive = !options.yes && ctx.isTTY && Boolean(process.stdin.isTTY);
  if (!options.yes && !interactive) {
    ctx.err("Setup needs an interactive terminal; run `attention setup --yes` to accept the defaults.");
    return EXIT_ERROR;
  }
  const focus = focusContext(ctx);
  const shell = currentShellTerminal(ctx);
  try {
    const result = await runSetup({
      prompter: interactive ? clackPrompter() : plainPrompter(ctx),
      yes: options.yes,
      existing: ctx.config,
      platform: ctx.platform,
      hooks: {
        settingsPath: ctx.settingsPath,
        plan: () => planInstall(readSettings(ctx.settingsPath), hookCommand(ctx.hookSpec)),
        install: () => void installHooks(ctx),
      },
      ensureToken: () => void ensureToken(ctx.paths),
      probeOllama,
      terminal: {
        backends: planFocus(shell, focus).map((a) => a.id),
        wayland: ctx.platform === "linux" && isWayland(ctx.env),
        testFocus: () => focusSession(shell, focus),
      },
      save: (config) => saveCliConfig(ctx.paths.configFile, config),
    });
    return result.ok ? EXIT_OK : EXIT_ERROR;
  } catch (error) {
    ctx.err(`Setup failed: ${(error as Error).message}`);
    return EXIT_ERROR;
  }
}
