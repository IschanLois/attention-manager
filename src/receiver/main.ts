import { createOllamaClassifier } from "../core/classifier/ollama.ts";
import { createLogger } from "../core/logger.ts";
import { isLoopbackUrl, loadConfig } from "./config.ts";
import { createReceiver } from "./server.ts";

const config = loadConfig();
const logger = createLogger(config.logLevel);

if (!config.ingestToken) {
  if (!config.allowNoToken) {
    logger.error("no ingest token found; run `pnpm hooks:install` to generate one, or set ATTENTION_ALLOW_NO_TOKEN=1 to accept unauthenticated loopback events", {
      tokenPath: config.tokenPath,
    });
    process.exit(2);
  }
  logger.warn("ATTENTION_ALLOW_NO_TOKEN=1: accepting unauthenticated loopback events", { tokenPath: config.tokenPath });
}
if (config.host !== "127.0.0.1" && config.host !== "localhost" && config.host !== "::1") {
  logger.warn("receiver is bound to a non-loopback address; other machines may reach it", { host: config.host });
}
if (!isLoopbackUrl(config.ollamaUrl)) {
  logger.warn("OLLAMA_URL is not loopback; event text would leave this machine", { url: config.ollamaUrl });
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
  maxSessions: config.maxSessions,
  retentionMs: config.retentionMs,
  classifier,
  logLevel: config.logLevel,
  logger,
});

const modelHealth = await classifier.health();
if (!modelHealth.reachable) logger.warn("local model runtime unreachable; running rule-based only", { url: config.ollamaUrl });
else if (!modelHealth.modelInstalled) logger.warn("model not installed; running rule-based only", { model: config.ollamaModel });
else {
  logger.info("local model available; warming up", { model: config.ollamaModel });
  const warmupStarted = Date.now();
  (classifier.warmUp?.() ?? Promise.resolve())
    .then(() => logger.info("model warm", { ms: Date.now() - warmupStarted }))
    .catch((error: unknown) => logger.warn("model warm-up failed", { error: error instanceof Error ? error.message : String(error) }));
}

const shutdown = async (signal: string) => {
  logger.info("shutting down", { signal });
  await receiver.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
