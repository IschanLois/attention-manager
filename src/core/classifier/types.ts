import type { Classification, EventType, Priority } from "../schemas.ts";

export interface ClassifierInput {
  eventType: EventType;
  notificationType: string | null;
  toolName: string | null;
  text: string;
  recentFailures: number;
}

export interface TaskClassifierInput {
  taskSummary: string | null;
  recentActions: string[];
  narration: string | null;
  ruleSeverity: Priority;
}

export interface ModelHealth {
  reachable: boolean;
  modelInstalled: boolean;
  model: string;
  url: string;
  error: string | null;
}

export interface ClassifierPort {
  classify(input: ClassifierInput): Promise<Classification | null>;
  classifyTask?(input: TaskClassifierInput): Promise<Classification | null>;
  health(): Promise<ModelHealth>;
  warmUp?(): Promise<void>;
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
