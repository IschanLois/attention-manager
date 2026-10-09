import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configSchema, DEFAULT_CONFIG, loadCliConfig, receiverDefaults, saveCliConfig } from "@/cli/config";
import { loadConfig } from "@/receiver/config";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "attention-config-"));
}

describe("cli config", () => {
  it("fills every default from an empty object", () => {
    const config = configSchema.parse({});
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config.classifier).toEqual({ enabled: true, ollamaUrl: "http://127.0.0.1:11434", model: "qwen3:1.7b" });
    expect(config.receiver.port).toBe(4318);
    expect(config.bell).toBe(true);
  });

  it("rejects an out-of-range port and an invalid URL", () => {
    expect(configSchema.safeParse({ receiver: { port: 70000 } }).success).toBe(false);
    expect(configSchema.safeParse({ classifier: { ollamaUrl: "not a url" } }).success).toBe(false);
  });

  it("reports a missing file as not existing and returns defaults", () => {
    const result = loadCliConfig(join(tempDir(), "config.json"));
    expect(result).toEqual({ ok: true, exists: false, config: DEFAULT_CONFIG });
  });

  it("reports malformed JSON and schema violations as errors", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "bad.json"), "{nope");
    writeFileSync(join(dir, "invalid.json"), JSON.stringify({ receiver: { port: "x" } }));
    expect(loadCliConfig(join(dir, "bad.json")).ok).toBe(false);
    expect(loadCliConfig(join(dir, "invalid.json")).ok).toBe(false);
  });

  it("round-trips through a 0600 file", () => {
    const file = join(tempDir(), "nested", "config.json");
    const config = configSchema.parse({ classifier: { enabled: false }, bell: false, terminal: { confirmed: "tmux" } });
    saveCliConfig(file, config);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(config);
    expect(loadCliConfig(file)).toEqual({ ok: true, exists: true, config });
  });

  it("maps the config into receiver defaults that env vars still override", () => {
    const config = configSchema.parse({ classifier: { model: "llama3.2:1b" }, receiver: { port: 5000 } });
    const defaults = receiverDefaults(config, { databaseFile: "/s/attention.db", tokenFile: "/c/ingest-token" });
    const fromDefaults = loadConfig({}, "/cwd", defaults);
    expect(fromDefaults.port).toBe(5000);
    expect(fromDefaults.ollamaModel).toBe("llama3.2:1b");
    expect(fromDefaults.databasePath).toBe("/s/attention.db");
    expect(fromDefaults.tokenPath).toBe("/c/ingest-token");
    const overridden = loadConfig({ RECEIVER_PORT: "6000", OLLAMA_MODEL: "m" }, "/cwd", defaults);
    expect(overridden.port).toBe(6000);
    expect(overridden.ollamaModel).toBe("m");
  });

  it("keeps the project-relative receiver defaults when nothing is injected", () => {
    const config = loadConfig({}, "/proj");
    expect(config.databasePath).toBe("/proj/data/attention.db");
    expect(config.tokenPath).toBe("/proj/data/ingest-token");
    expect(config.port).toBe(4318);
  });
});
