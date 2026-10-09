interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  private readonly capacity: number;
  private readonly refillPerMs: number;

  constructor(capacity: number, refillPerMs: number) {
    this.capacity = capacity;
    this.refillPerMs = refillPerMs;
  }

  take(key: string, nowMs: number): boolean {
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: nowMs };
    const elapsed = Math.max(0, nowMs - bucket.updatedAt);
    const refilled = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    const allowed = refilled >= 1;
    this.buckets.set(key, { tokens: allowed ? refilled - 1 : refilled, updatedAt: nowMs });
    if (this.buckets.size > 10_000) this.evict(nowMs);
    return allowed;
  }

  private evict(nowMs: number) {
    for (const [key, bucket] of this.buckets) {
      if (nowMs - bucket.updatedAt > 10 * 60_000) this.buckets.delete(key);
    }
  }
}

export function perMinuteLimiter(perMinute: number): TokenBucketLimiter {
  return new TokenBucketLimiter(perMinute, perMinute / 60_000);
}
