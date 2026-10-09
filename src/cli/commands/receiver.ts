import { createOllamaClassifier } from "../../core/classifier/ollama.ts";
import type { ClassifierPort } from "../../core/classifier/types.ts";
import { createLogger } from "../../core/logger.ts";
import { isLoopbackUrl, loadConfig } from "../../receiver/config.ts";
import { createReceiver, type Receiver } from "../../receiver/server.ts";
import { EXIT_ERROR, EXIT_MISCONFIGURED } from "../args.ts";
import { receiverDefaults } from "../config.ts";
import type { CliContext } from "../context.ts";
import { ensureToken } from "../hooks.ts";
import { APP_NAME, VERSION } from "../meta.ts";

const IDLE_EXIT_AFTER_MS = 3_000;
const IDLE_STARTUP_GRACE_MS = 20_000;

function disabledClassifier(url: string, model: string): ClassifierPort {
  return {
    async classify() {
      return null;
    },
    async health() {
      return { reachable: false, modelInstalled: false, model, url, error: "local AI is disabled in the config" };
    },
  };
}

// A receiver the UI spawned exits once no UI has been attached for a few seconds, so
// quitting (or crashing) the last UI never leaves an orphaned process behind.
function watchIdle(receiver: Receiver, onIdle: () => void): void {
  const startedAt = Date.now();
  let idleSince: number | null = null;
  let everAttached = false;
  const timer = setInterval(() => {
    const now = Date.now();
    if (receiver.sseClients() > 0) {
      everAttached = true;
      idleSince = null;
      return;
    }
    idleSince ??= now;
    const graceOver = everAttached || now - startedAt > IDLE_STARTUP_GRACE_MS;
    if (graceOver && now - idleSince >= IDLE_EXIT_AFTER_MS) {
      clearInterval(timer);
      onIdle();
    }
  }, 500);
  timer.unref();
}

export async function runReceiver(ctx: CliContext, options: { port: number | null; exitWhenIdle: boolean }): Promise<number> {
  ensureToken(ctx.paths);
  const config = loadConfig(options.port ? { ...ctx.env, RECEIVER_PORT: String(options.port) } : ctx.env, process.cwd(), receiverDefaults(ctx.config, ctx.paths));
  const logger = createLogger(config.logLevel);
  if (config.host !== "127.0.0.1" && config.host !== "localhost" && config.host !== "::1") {
    logger.warn("receiver is bound to a non-loopback address; other machines may reach it", { host: config.host });
  }
  if (ctx.config.classifier.enabled && !isLoopbackUrl(config.ollamaUrl)) {
    logger.warn("the Ollama URL is not loopback; event text would leave this machine", { url: config.ollamaUrl });
  }
  const classifier = ctx.config.classifier.enabled
    ? createOllamaClassifier({ url: config.ollamaUrl, model: config.ollamaModel, timeoutMs: config.classifyTimeoutMs })
    : disabledClassifier(config.ollamaUrl, config.ollamaModel);

  let receiver: Receiver;
  try {
    receiver = await createReceiver({
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
      captureTaskContext: config.captureTaskContext,
      classifier,
      logLevel: config.logLevel,
      logger,
      version: VERSION,
      app: APP_NAME,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      ctx.err(`Port ${config.port} is already in use. Another receiver may be running (check \`attention doctor\`), or set RECEIVER_PORT / "receiver.port" in ${ctx.paths.configFile}.`);
      return EXIT_MISCONFIGURED;
    }
    if (code === "EACCES") {
      ctx.err(`Not allowed to listen on port ${config.port}; choose a port above 1024.`);
      return EXIT_MISCONFIGURED;
    }
    ctx.err(`The receiver failed to start: ${(error as Error).message}`);
    return EXIT_ERROR;
  }

  if (ctx.config.classifier.enabled) {
    const modelHealth = await classifier.health();
    if (!modelHealth.reachable) logger.warn("local model runtime unreachable; running rule-based only", { url: config.ollamaUrl });
    else if (!modelHealth.modelInstalled) logger.warn("model not installed; running rule-based only", { model: config.ollamaModel });
    else {
      const warmupStarted = Date.now();
      (classifier.warmUp?.() ?? Promise.resolve())
        .then(() => logger.info("model warm", { ms: Date.now() - warmupStarted }))
        .catch((error: unknown) => logger.warn("model warm-up failed", { error: error instanceof Error ? error.message : String(error) }));
    }
  }

  return new Promise<number>((resolve) => {
    let stopping = false;
    const stop = (reason: string) => {
      if (stopping) return;
      stopping = true;
      logger.info("shutting down", { reason });
      receiver.close().finally(() => resolve(0));
    };
    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGHUP", () => stop("SIGHUP"));
    if (options.exitWhenIdle) watchIdle(receiver, () => stop("no UI attached"));
  });
}
