import { receiverUrl, unreachableResponse } from "@/lib/receiver";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const controller = new AbortController();
  request.signal.addEventListener("abort", () => controller.abort(), { once: true });

  let upstream: Response;
  try {
    upstream = await fetch(`${receiverUrl()}/api/stream`, {
      cache: "no-store",
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
  } catch {
    return unreachableResponse();
  }
  if (!upstream.ok || !upstream.body) {
    controller.abort();
    return unreachableResponse();
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
