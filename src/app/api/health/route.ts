import { proxyJson } from "@/lib/receiver";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return proxyJson("/api/health");
}
