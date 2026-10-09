import { normalizeHookEvent } from "../core/events/normalize.ts";
import type { ClassifierInput, ClassifierPort, TaskClassifierInput } from "../core/classifier/types.ts";
import type { Logger } from "../core/logger.ts";
import type { Store } from "../core/persistence/store.ts";
import type { NormalizedEvent, Session } from "../core/schemas.ts";
import {
  applyClassification,
  applyTaskClassification,
  isSameTask,
  recordClassificationFailure,
  recordTaskClassificationFailure,
  reduceSession,
  shouldClassify,
  shouldClassifyTask,
} from "../core/sessions/state-machine.ts";
import { ClassifierError } from "../core/classifier/types.ts";

export type IngestResult =
  | { status: "accepted"; session: Session }
  | { status: "ignored"; reason: "unsupported_event" | "duplicate" }
  | { status: "rejected"; reason: "invalid_payload" };

export interface PipelineOptions {
  store: Store;
  classifier: ClassifierPort;
  logger: Logger;
  dedupeWindowMs: number;
  maxSessions?: number;
  retryDelayMs?: number;
  captureTaskContext?: boolean;
  onSessionChanged: (session: Session) => void;
  onSessionRemoved?: (sessionId: string) => void;
  onClassificationError: (message: string) => void;
  now?: () => number;
}

type JobKind = "attention" | "task";

interface PendingJob {
  kind: JobKind;
  session: Session;
  event: NormalizedEvent;
  seq: number;
}

export class IngestPipeline {
  private readonly sessions = new Map<string, Session>();
  private readonly pendingJobs = new Map<string, PendingJob>();
  private readonly queue: string[] = [];
  private drainPromise: Promise<void> | null = null;
  private closed = false;
  private readonly now: () => number;

  private readonly options: PipelineOptions;

  constructor(options: PipelineOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    for (const session of options.store.listSessions()) this.sessions.set(session.sessionId, session);
  }

  listSessions(): Session[] {
    return [...this.sessions.values()];
  }

  getSession(sessionId: string): Session | null {
    return this.sessions.get(sessionId) ?? null;
  }

  ingest(raw: unknown): IngestResult {
    const nowMs = this.now();
    const normalized = normalizeHookEvent(raw, new Date(nowMs).toISOString());
    if (!normalized.ok) {
      return normalized.reason === "unsupported_event"
        ? { status: "ignored", reason: "unsupported_event" }
        : { status: "rejected", reason: "invalid_payload" };
    }
    const event = this.options.captureTaskContext === false
      ? { ...normalized.event, taskKind: null, taskText: null, riskHits: [] }
      : normalized.event;
    if (this.options.dedupeWindowMs > 0 && event.dedupeKey && this.options.store.hasRecentEvent(event.dedupeKey, nowMs, this.options.dedupeWindowMs)) {
      return { status: "ignored", reason: "duplicate" };
    }

    const previous = this.sessions.get(event.sessionId) ?? null;
    if (!previous) this.evictForNewSession();
    const next = reduceSession(previous, event);
    this.commit(next);
    this.options.store.insertEvent(event);

    if (shouldClassify(next, event)) this.enqueue("attention", next, event);
    else this.pendingJobs.delete(`${event.sessionId}:attention`);
    if (this.options.classifier.classifyTask && shouldClassifyTask(next, event)) this.enqueue("task", next, event);
    else this.pendingJobs.delete(`${event.sessionId}:task`);
    return { status: "accepted", session: next };
  }

  purge(nowMs: number, maxAgeMs: number): { sessions: number; events: number } {
    const result = this.options.store.purge(nowMs, maxAgeMs);
    const cutoff = nowMs - maxAgeMs;
    for (const [id, session] of this.sessions) {
      if (session.endedAt && Date.parse(session.endedAt) < cutoff) {
        this.sessions.delete(id);
        this.pendingJobs.delete(`${id}:attention`);
        this.pendingJobs.delete(`${id}:task`);
        this.options.onSessionRemoved?.(id);
      }
    }
    return result;
  }

  private evictForNewSession(): void {
    const max = this.options.maxSessions ?? 1000;
    if (this.sessions.size < max) return;
    const victims = [...this.sessions.values()].sort((a, b) => {
      const endedDiff = Number(b.status === "ended") - Number(a.status === "ended");
      if (endedDiff !== 0) return endedDiff;
      return Date.parse(a.lastSeenAt) - Date.parse(b.lastSeenAt);
    });
    for (const victim of victims.slice(0, this.sessions.size - max + 1)) {
      this.sessions.delete(victim.sessionId);
      this.pendingJobs.delete(`${victim.sessionId}:attention`);
      this.pendingJobs.delete(`${victim.sessionId}:task`);
      this.options.store.deleteSession(victim.sessionId);
      this.options.onSessionRemoved?.(victim.sessionId);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.pendingJobs.clear();
    this.queue.length = 0;
    if (this.drainPromise) await this.drainPromise;
  }

  private commit(session: Session): void {
    this.sessions.set(session.sessionId, session);
    this.options.store.upsertSession(session);
    this.options.onSessionChanged(session);
  }

  private enqueue(kind: JobKind, session: Session, event: NormalizedEvent): void {
    const key = `${session.sessionId}:${kind}`;
    const replacing = this.pendingJobs.has(key);
    this.pendingJobs.set(key, { kind, session, event, seq: session.eventSeq });
    if (!replacing) this.queue.push(key);
    void this.drain();
  }

  private drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = (async () => {
      try {
        while (this.queue.length > 0 && !this.closed) {
          const key = this.queue.shift()!;
          const job = this.pendingJobs.get(key);
          this.pendingJobs.delete(key);
          if (!job) continue;
          try {
            await this.runJob(job);
          } catch (error) {
            this.options.logger.error("classification job crashed", { error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
          }
        }
      } finally {
        this.drainPromise = null;
      }
    })();
    return this.drainPromise;
  }

  // Attention verdicts describe the latest event; task verdicts describe the current task.
  private isCurrent(job: PendingJob): boolean {
    const current = this.sessions.get(job.session.sessionId);
    if (!current) return false;
    if (job.kind === "task") return isSameTask(current, job.session.taskSummary);
    return current.status !== "ended" && current.eventSeq === job.seq;
  }

  private async classifyWithRetry(input: ClassifierInput | TaskClassifierInput, job: PendingJob) {
    const run = () =>
      job.kind === "task"
        ? this.options.classifier.classifyTask!(input as TaskClassifierInput)
        : this.options.classifier.classify(input as ClassifierInput);
    try {
      return await run();
    } catch (error) {
      const timedOut = error instanceof ClassifierError && error.kind === "timeout";
      const stillCurrent = () => this.isCurrent(job);
      if (!timedOut || this.closed || !stillCurrent()) throw error;
      this.options.logger.debug("classification timed out; retrying once", { sessionId: job.session.sessionId });
      await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs ?? 2000));
      if (this.closed || !stillCurrent()) throw error;
      return await run();
    }
  }

  private async runJob(job: PendingJob): Promise<void> {
    const current = this.sessions.get(job.session.sessionId);
    if (!current || !this.isCurrent(job)) return;
    const input: ClassifierInput | TaskClassifierInput = job.kind === "task"
      ? { taskSummary: current.taskSummary, recentActions: current.recentActions, narration: current.lastNarration, ruleSeverity: current.taskRuleSeverity }
      : {
          eventType: job.event.type,
          notificationType: job.event.notificationType,
          toolName: job.event.toolName,
          text: job.event.classifierText ?? "",
          recentFailures: current.recentFailureTimes.length,
        };
    try {
      const result = await this.classifyWithRetry(input, job);
      if (this.closed) return;
      const latest = this.sessions.get(job.session.sessionId);
      if (!latest || result === null) return;
      const at = new Date(this.now()).toISOString();
      const updated = job.kind === "task"
        ? applyTaskClassification(latest, result, at, job.session.taskSummary)
        : applyClassification(latest, job.event, result, at, job.seq);
      if (updated !== latest) this.commit(updated);
    } catch (error) {
      const message = error instanceof ClassifierError ? `${error.kind}: ${error.message}` : "classifier failure";
      this.options.logger.warn("classification failed", { sessionId: job.session.sessionId, error: message });
      this.options.onClassificationError(message);
      if (this.closed) return;
      const latest = this.sessions.get(job.session.sessionId);
      if (!latest) return;
      const at = new Date(this.now()).toISOString();
      const updated = job.kind === "task"
        ? recordTaskClassificationFailure(latest, at, job.session.taskSummary)
        : recordClassificationFailure(latest, job.event, message.slice(0, 200), at, job.seq);
      if (updated !== latest) this.commit(updated);
    }
  }
}
