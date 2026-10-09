import type { HealthReport, SessionsSnapshot } from "./types";

const DEFAULT_RECEIVER_URL = "http://127.0.0.1:4318";
const JSON_TIMEOUT_MS = 5_000;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export function receiverUrl(): string {
  return (process.env.RECEIVER_URL?.trim() || DEFAULT_RECEIVER_URL).replace(/\/+$/, "");
}

export function unreachableResponse(): Response {
  return new Response(JSON.stringify({ error: "receiver unreachable" }), { status: 503, headers: JSON_HEADERS });
}

export async function proxyJson(path: string): Promise<Response> {
  try {
    const upstream = await fetch(`${receiverUrl()}${path}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
    const body = await upstream.text();
    return new Response(body, { status: upstream.status, headers: JSON_HEADERS });
  } catch {
    return unreachableResponse();
  }
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${receiverUrl()}${path}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function fetchSnapshot(): Promise<SessionsSnapshot | null> {
  return fetchJson<SessionsSnapshot>("/api/sessions");
}

export function fetchHealth(): Promise<HealthReport | null> {
  return fetchJson<HealthReport>("/api/health");
}
