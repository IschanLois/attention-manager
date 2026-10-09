import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { ConfigDefaults } from "../receiver/config.ts";
import type { AppPaths } from "./paths.ts";
import { ensurePrivateDir } from "./paths.ts";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_MODEL = "qwen3:1.7b";
export const DEFAULT_PORT = 4318;

export const configSchema = z.object({
  version: z.literal(1).default(1),
  classifier: z
    .object({
      enabled: z.boolean().default(true),
      ollamaUrl: z.url({ protocol: /^https?$/ }).max(2048).default(DEFAULT_OLLAMA_URL),
      model: z.string().trim().min(1).max(128).default(DEFAULT_MODEL),
    })
    .prefault({}),
  terminal: z.object({ confirmed: z.string().max(64).nullable().default(null) }).prefault({}),
  bell: z.boolean().default(true),
  receiver: z.object({ port: z.number().int().min(1).max(65535).default(DEFAULT_PORT) }).prefault({}),
});

export type CliConfig = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: CliConfig = configSchema.parse({});

export type LoadResult = { ok: true; exists: boolean; config: CliConfig } | { ok: false; error: string };

export function loadCliConfig(file: string): LoadResult {
  if (!existsSync(file)) return { ok: true, exists: false, config: DEFAULT_CONFIG };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { ok: false, error: `${file} is not valid JSON: ${(error as Error).message}` };
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `${file} is invalid: ${z.prettifyError(parsed.error)}` };
  return { ok: true, exists: true, config: parsed.data };
}

export function saveCliConfig(file: string, config: CliConfig): void {
  ensurePrivateDir(dirname(file));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function receiverDefaults(config: CliConfig, paths: Pick<AppPaths, "databaseFile" | "tokenFile">): ConfigDefaults {
  return {
    port: config.receiver.port,
    databasePath: paths.databaseFile,
    tokenPath: paths.tokenFile,
    ollamaUrl: config.classifier.ollamaUrl,
    ollamaModel: config.classifier.model,
  };
}
