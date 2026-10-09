import type { ServerResponse } from "node:http";

export class SseHub {
  private readonly clients = new Set<ServerResponse>();
  private heartbeat: NodeJS.Timeout | null = null;

  private readonly heartbeatMs: number;
  readonly maxClients: number;

  constructor(heartbeatMs = 15_000, maxClients = 16) {
    this.heartbeatMs = heartbeatMs;
    this.maxClients = maxClients;
  }

  get full(): boolean {
    return this.clients.size >= this.maxClients;
  }

  get size(): number {
    return this.clients.size;
  }

  add(res: ServerResponse, initial: Array<{ event: string; data: unknown }>): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    for (const message of initial) res.write(format(message.event, message.data));
    this.clients.add(res);
    res.on("close", () => {
      this.clients.delete(res);
    });
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => this.broadcastRaw(": heartbeat\n\n"), this.heartbeatMs);
      this.heartbeat.unref();
    }
  }

  send(res: ServerResponse, event: string, data: unknown): void {
    if (!this.clients.has(res) || res.writableEnded || res.destroyed) return;
    res.write(format(event, data));
  }

  broadcast(event: string, data: unknown): void {
    this.broadcastRaw(format(event, data));
  }

  closeAll(): void {
    for (const res of this.clients) res.end();
    this.clients.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private broadcastRaw(payload: string): void {
    for (const res of this.clients) {
      if (res.writableEnded || res.destroyed) {
        this.clients.delete(res);
        continue;
      }
      res.write(payload);
    }
  }
}

function format(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
