import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clockTicker } from "@/lib/hooks/useClock";

describe("clockTicker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps stable subscribe and snapshot functions for a cadence", () => {
    const a = clockTicker(7_000);
    const b = clockTicker(7_000);
    expect(a.subscribe).toBe(b.subscribe);
    expect(a.getSnapshot).toBe(b.getSnapshot);
  });

  it("only changes the snapshot on a timer tick, not on subscribe or unsubscribe", () => {
    const t = clockTicker(11_000);
    const before = t.getSnapshot();
    const unsubscribe = t.subscribe(() => undefined);
    expect(t.getSnapshot()).toBe(before);
    unsubscribe();
    const again = t.subscribe(() => undefined);
    expect(t.getSnapshot()).toBe(before);
    vi.advanceTimersByTime(11_000);
    expect(t.getSnapshot()).not.toBe(before);
    again();
  });

  it("notifies listeners on each tick and stops the interval when the last one leaves", () => {
    const t = clockTicker(13_000);
    const listener = vi.fn();
    const unsubscribe = t.subscribe(listener);
    vi.advanceTimersByTime(26_000);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(t.timer).toBeNull();
    vi.advanceTimersByTime(13_000);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
