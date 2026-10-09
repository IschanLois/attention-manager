import { proxyJson } from "@/lib/receiver";

export const dynamic = "force-dynamic";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  if (!SESSION_ID_PATTERN.test(id)) {
    return Response.json({ error: "invalid session id" }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  return proxyJson(`/api/sessions/${encodeURIComponent(id)}`);
}
