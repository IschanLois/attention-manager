import type { HealthReport, SessionDetail, SessionsSnapshot } from "./model/types.ts";

export class ReceiverUnavailableError extends Error {}

async function getJson<T>(url: string, timeoutMs: number): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new ReceiverUnavailableError((error as Error).message);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new ReceiverUnavailableError(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface ReceiverClient {
  baseUrl: string;
  health(): Promise<HealthReport>;
  sessions(): Promise<SessionsSnapshot>;
  session(sessionId: string): Promise<SessionDetail | null>;
}

export function createClient(baseUrl: string, timeoutMs = 3000): ReceiverClient {
  const required = async <T>(path: string): Promise<T> => {
    const body = await getJson<T>(`${baseUrl}${path}`, timeoutMs);
    if (body === null) throw new ReceiverUnavailableError(`${path} not found`);
    return body;
  };
  return {
    baseUrl,
    health: () => required<HealthReport>("/api/health"),
    sessions: () => required<SessionsSnapshot>("/api/sessions"),
    session: (sessionId) => getJson<SessionDetail>(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`, timeoutMs),
  };
}

export const RECEIVER_NOT_RUNNING = "The receiver is not running. Start the UI with `attention` (it starts one) or run `attention receiver`.";
