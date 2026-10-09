import { normalizeHookEvent } from "../core/events/normalize.ts";
import type { ClassifierPort } from "../core/classifier/types.ts";
import type { Logger } from "../core/logger.ts";
import type { Store } from "../core/persistence/store.ts";
import type { NormalizedEvent, Session } from "../core/schemas.ts";
import {
  applyClassification,
  recordClassificationFailure,
  reduceSession,
  shouldClassify,
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
  onSessionChanged: (session: Session) => void;
  onClassificationError: (message: string) => void;
  now?: () => number;
}

interface PendingJob {
  session: Session;
  event: NormalizedEvent;
}

export class IngestPipeline {
  private readonly sessions = new Map<string, Session>();
  private readonly pendingJobs = new Map<string, PendingJob>();
  private readonly queue: string[] = [];
  private draining = false;
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
    const event = normalized.event;
    if (this.options.dedupeWindowMs > 0 && this.options.store.hasRecentEvent(event.dedupeKey, nowMs, this.options.dedupeWindowMs)) {
      return { status: "ignored", reason: "duplicate" };
    }

    const previous = this.sessions.get(event.sessionId) ?? null;
    const next = reduceSession(previous, event);
    this.commit(next);
    this.options.store.insertEvent(event);

    if (shouldClassify(next, event)) this.enqueue(next, event);
    else this.pendingJobs.delete(event.sessionId);
    return { status: "accepted", session: next };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.pendingJobs.clear();
    this.queue.length = 0;
  }

  private commit(session: Session): void {
    this.sessions.set(session.sessionId, session);
    this.options.store.upsertSession(session);
    this.options.onSessionChanged(session);
  }

  private enqueue(session: Session, event: NormalizedEvent): void {
    const replacing = this.pendingJobs.has(session.sessionId);
    this.pendingJobs.set(session.sessionId, { session, event });
    if (!replacing) this.queue.push(session.sessionId);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const sessionId = this.queue.shift()!;
        const job = this.pendingJobs.get(sessionId);
        this.pendingJobs.delete(sessionId);
        if (job) await this.runJob(job);
      }
    } finally {
      this.draining = false;
    }
  }

  private async runJob(job: PendingJob): Promise<void> {
    const current = this.sessions.get(job.session.sessionId);
    if (!current || current.lastSeenAt !== job.event.receivedAt || current.status === "ended") return;
    const input = {
      eventType: job.event.type,
      notificationType: job.event.notificationType,
      toolName: job.event.toolName,
      text: job.event.classifierText ?? "",
      recentFailures: current.recentFailureTimes.length,
    };
    try {
      const result = await this.options.classifier.classify(input);
      const latest = this.sessions.get(job.session.sessionId);
      if (!latest || result === null) return;
      const updated = applyClassification(latest, job.event, result, new Date(this.now()).toISOString());
      if (updated !== latest) this.commit(updated);
    } catch (error) {
      const message = error instanceof ClassifierError ? `${error.kind}: ${error.message}` : "classifier failure";
      this.options.logger.warn("classification failed", { sessionId: job.session.sessionId, error: message });
      this.options.onClassificationError(message);
      const latest = this.sessions.get(job.session.sessionId);
      if (!latest) return;
      const updated = recordClassificationFailure(latest, job.event, message.slice(0, 200), new Date(this.now()).toISOString());
      if (updated !== latest) this.commit(updated);
    }
  }
}
