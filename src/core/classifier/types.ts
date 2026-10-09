import type { Classification, EventType } from "../schemas.ts";

export interface ClassifierInput {
  eventType: EventType;
  notificationType: string | null;
  toolName: string | null;
  text: string;
  recentFailures: number;
}

export interface ModelHealth {
  reachable: boolean;
  modelInstalled: boolean;
  model: string;
  url: string;
  error: string | null;
}

export interface ClassifierPort {
  classify(input: ClassifierInput, signal?: AbortSignal): Promise<Classification | null>;
  health(): Promise<ModelHealth>;
}

export type ClassifierErrorKind = "unreachable" | "model_missing" | "timeout" | "invalid_output" | "http_error" | "rate_limited";

export class ClassifierError extends Error {
  readonly kind: ClassifierErrorKind;

  constructor(message: string, kind: ClassifierErrorKind) {
    super(message);
    this.name = "ClassifierError";
    this.kind = kind;
  }
}
