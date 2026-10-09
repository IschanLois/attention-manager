import { homedir } from "node:os";
import type { CliConfig } from "./config.ts";
import { loadCliConfig, DEFAULT_CONFIG } from "./config.ts";
import { execFocusCommand } from "./focus/exec.ts";
import { ringTty } from "./focus/highlight.ts";
import type { Exec, FocusContext } from "./focus/types.ts";
import { defaultHookSpec, defaultSettingsPath, type HookCommandSpec } from "./hooks.ts";
import { APP_NAME } from "./meta.ts";
import { resolvePaths, type AppPaths } from "./paths.ts";
import type { SupportedPlatform } from "./platform.ts";

export type Env = Record<string, string | undefined>;

export interface CliContext {
  platform: SupportedPlatform;
  env: Env;
  paths: AppPaths;
  config: CliConfig;
  configExists: boolean;
  configError?: string;
  settingsPath: string;
  hookSpec: HookCommandSpec;
  receiverUrl: string;
  color: boolean;
  isTTY: boolean;
  exec: Exec;
  ringTty: FocusContext["ringTty"];
  out(line: string): void;
  err(line: string): void;
}

export function receiverPort(config: CliConfig, env: Env): number {
  const fromEnv = Number(env.RECEIVER_PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536 ? fromEnv : config.receiver.port;
}

export function focusContext(ctx: Pick<CliContext, "platform" | "env" | "exec" | "ringTty">): FocusContext {
  return { platform: ctx.platform, env: ctx.env, exec: ctx.exec, ringTty: ctx.ringTty };
}

// Colour follows NO_COLOR (https://no-color.org), TERM=dumb, non-TTY output and --no-color.
export function colorEnabled(flag: boolean, env: Env, isTTY: boolean): boolean {
  if (!flag || !isTTY) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  return env.TERM !== "dumb";
}

export function createContext(platform: SupportedPlatform, colorFlag: boolean): CliContext {
  const env = process.env;
  const paths = resolvePaths({ platform, env, home: homedir(), appName: APP_NAME });
  const loaded = loadCliConfig(paths.configFile);
  const config = loaded.ok ? loaded.config : DEFAULT_CONFIG;
  const isTTY = Boolean(process.stdout.isTTY);
  return {
    platform,
    env,
    paths,
    config,
    configExists: loaded.ok ? loaded.exists : true,
    configError: loaded.ok ? undefined : loaded.error,
    settingsPath: defaultSettingsPath(env),
    hookSpec: defaultHookSpec(),
    receiverUrl: env.ATTENTION_RECEIVER_URL?.replace(/\/+$/, "") || `http://127.0.0.1:${receiverPort(config, env)}`,
    color: colorEnabled(colorFlag, env, isTTY),
    isTTY,
    exec: execFocusCommand,
    ringTty,
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
  };
}
