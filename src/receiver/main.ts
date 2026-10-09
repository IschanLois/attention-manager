import { createOllamaClassifier } from "../core/classifier/ollama.ts";
import { createLogger } from "../core/logger.ts";
import { loadConfig } from "./config.ts";
import { createReceiver } from "./server.ts";

const config = loadConfig();
const logger = createLogger(config.logLevel);

if (!config.ingestToken) {
  logger.warn("no ingest token configured; run `pnpm hooks:install` to generate one. Accepting unauthenticated loopback events.", {
    tokenPath: config.tokenPath,
  });
}

const classifier = createOllamaClassifier({ url: config.ollamaUrl, model: config.ollamaModel, timeoutMs: config.classifyTimeoutMs });

const receiver = await createReceiver({
  host: config.host,
  port: config.port,
  databasePath: config.databasePath,
  ingestToken: config.ingestToken,
  maxBodyBytes: config.maxBodyBytes,
  eventHistoryLimit: config.eventHistoryLimit,
  staleAfterMs: config.staleAfterMs,
  dedupeWindowMs: config.dedupeWindowMs,
  rateLimit: config.rateLimit,
  classifier,
  logLevel: config.logLevel,
  logger,
});

const modelHealth = await classifier.health();
if (!modelHealth.reachable) logger.warn("local model runtime unreachable; running rule-based only", { url: config.ollamaUrl });
else if (!modelHealth.modelInstalled) logger.warn("model not installed; running rule-based only", { model: config.ollamaModel });
else logger.info("local model available", { model: config.ollamaModel });

const shutdown = async (signal: string) => {
  logger.info("shutting down", { signal });
  await receiver.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
