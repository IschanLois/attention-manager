import { chmodSync, mkdirSync } from "node:fs";
import { posix } from "node:path";
import { isSupportedPlatform } from "./platform.ts";

export interface AppPaths {
  configDir: string;
  stateDir: string;
  logDir: string;
  configFile: string;
  tokenFile: string;
  headerFile: string;
  databaseFile: string;
  receiverLog: string;
}

export interface PathInputs {
  platform: string;
  env: Record<string, string | undefined>;
  home: string;
  appName: string;
}

export class UnsupportedPlatformError extends Error {}

function absolute(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && posix.isAbsolute(trimmed) ? trimmed : null;
}

export function resolvePaths({ platform, env, home, appName }: PathInputs): AppPaths {
  if (!isSupportedPlatform(platform)) throw new UnsupportedPlatformError(`unsupported platform: ${platform}`);
  const { join, dirname } = posix;
  const xdgConfig = absolute(env.XDG_CONFIG_HOME);
  const xdgState = absolute(env.XDG_STATE_HOME);

  let configDir: string;
  let stateDir: string;
  let logDir: string | null = null;
  if (platform === "darwin" && !xdgConfig && !xdgState) {
    configDir = join(home, "Library", "Application Support", appName);
    stateDir = configDir;
    logDir = join(home, "Library", "Logs", appName);
  } else {
    configDir = join(xdgConfig ?? join(home, ".config"), appName);
    stateDir = join(xdgState ?? join(home, ".local", "state"), appName);
  }
  configDir = absolute(env.ATTENTION_CONFIG_DIR) ?? configDir;
  stateDir = absolute(env.ATTENTION_STATE_DIR) ?? stateDir;
  logDir = absolute(env.ATTENTION_STATE_DIR) ? join(stateDir, "logs") : (logDir ?? join(stateDir, "logs"));

  const tokenFile = absolute(env.INGEST_TOKEN_PATH) ?? join(configDir, "ingest-token");
  return {
    configDir,
    stateDir,
    logDir,
    configFile: join(configDir, "config.json"),
    tokenFile,
    headerFile: join(dirname(tokenFile), "ingest-header"),
    databaseFile: absolute(env.DATABASE_PATH) ?? join(stateDir, "attention.db"),
    receiverLog: join(logDir, "receiver.log"),
  };
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best effort on filesystems without POSIX modes
  }
}
