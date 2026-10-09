import { useSyncExternalStore } from "react";

interface Ticker {
  value: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
}

const tickers = new Map<number, Ticker>();

function ticker(intervalMs: number): Ticker {
  let entry = tickers.get(intervalMs);
  if (!entry) {
    entry = { value: Date.now(), listeners: new Set(), timer: null };
    tickers.set(intervalMs, entry);
  }
  return entry;
}

function subscribeTo(intervalMs: number) {
  return (listener: () => void) => {
    const entry = ticker(intervalMs);
    if (entry.listeners.size === 0) {
      entry.value = Date.now();
      entry.timer = setInterval(() => {
        entry.value = Date.now();
        for (const fn of entry.listeners) fn();
      }, intervalMs);
    }
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0 && entry.timer) {
        clearInterval(entry.timer);
        entry.timer = null;
      }
    };
  };
}

const noopSubscribe = () => () => {};
const zero = () => 0;

/**
 * Shared ticking clock: one interval per cadence regardless of how many components read it.
 * `serverNowIso` is used for the server render and hydration so relative times match the HTML.
 */
export function useClock(intervalMs: number, serverNowIso: string, enabled = true): number {
  const serverNow = Date.parse(serverNowIso);
  return useSyncExternalStore(
    enabled ? subscribeTo(intervalMs) : noopSubscribe,
    enabled ? () => ticker(intervalMs).value : zero,
    () => (Number.isNaN(serverNow) ? 0 : serverNow),
  );
}
