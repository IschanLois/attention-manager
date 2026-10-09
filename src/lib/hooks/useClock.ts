import { useSyncExternalStore } from "react";

interface Ticker {
  value: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => number;
}

const tickers = new Map<number, Ticker>();

// One ticker per cadence. The subscribe and snapshot functions must keep a stable
// identity across renders, and the snapshot must only change on a timer tick;
// otherwise useSyncExternalStore resubscribes and re-renders without end.
export function clockTicker(intervalMs: number): Ticker {
  let entry = tickers.get(intervalMs);
  if (entry) return entry;
  const created: Ticker = {
    value: Date.now(),
    listeners: new Set(),
    timer: null,
    subscribe(listener) {
      if (created.listeners.size === 0) {
        created.timer = setInterval(() => {
          created.value = Date.now();
          for (const fn of created.listeners) fn();
        }, intervalMs);
      }
      created.listeners.add(listener);
      return () => {
        created.listeners.delete(listener);
        if (created.listeners.size === 0 && created.timer) {
          clearInterval(created.timer);
          created.timer = null;
        }
      };
    },
    getSnapshot: () => created.value,
  };
  entry = created;
  tickers.set(intervalMs, entry);
  return entry;
}

const noopSubscribe = () => () => {};
const zero = () => 0;

/**
 * Shared ticking clock: one interval per cadence regardless of how many components read it.
 * `serverNowIso` is used for the server render and hydration so relative times match the HTML.
 */
export function useClock(intervalMs: number, serverNowIso: string, enabled = true): number {
  const serverNow = Date.parse(serverNowIso);
  const entry = clockTicker(intervalMs);
  return useSyncExternalStore(
    enabled ? entry.subscribe : noopSubscribe,
    enabled ? entry.getSnapshot : zero,
    () => (Number.isNaN(serverNow) ? 0 : serverNow),
  );
}
