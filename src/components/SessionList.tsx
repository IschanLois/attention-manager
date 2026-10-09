"use client";

import { useCallback, useRef, useSyncExternalStore, type KeyboardEvent, type RefObject } from "react";
import { isStale } from "@/lib/sort";
import type { SessionView } from "@/lib/types";
import { ChevronIcon } from "./icons";
import { SessionCard } from "./SessionCard";

export interface SessionListProps {
  active: SessionView[];
  ended: SessionView[];
  selectedId: string | null;
  nowMs: number;
  staleAfterMs: number;
  forceStale: boolean;
  updatedAt: Record<string, number>;
  onSelect: (sessionId: string) => void;
  onEscape: () => void;
}

const ENDED_OPEN_STORAGE = "attention-manager:ended-open";
const endedOpenListeners = new Set<() => void>();

function readEndedOpen(): boolean {
  try {
    return window.localStorage.getItem(ENDED_OPEN_STORAGE) === "1";
  } catch {
    return false;
  }
}

function writeEndedOpen(open: boolean): void {
  try {
    window.localStorage.setItem(ENDED_OPEN_STORAGE, open ? "1" : "0");
  } catch {
    /* storage unavailable; the collapsed state is a convenience only */
  }
  for (const listener of endedOpenListeners) listener();
}

function subscribeEndedOpen(listener: () => void) {
  endedOpenListeners.add(listener);
  return () => {
    endedOpenListeners.delete(listener);
  };
}

const endedClosedOnServer = () => false;

type KeyHandler = (e: KeyboardEvent<HTMLLIElement>) => void;

function useRovingList(
  sessions: SessionView[],
  onSelect: (id: string) => void,
  onEscape: () => void,
): { refs: RefObject<Map<string, HTMLLIElement>>; handleKey: (id: string) => KeyHandler } {
  const refs = useRef(new Map<string, HTMLLIElement>());
  const handleKey = useCallback(
    (id: string): KeyHandler =>
      (e) => {
        const index = sessions.findIndex((s) => s.sessionId === id);
        const focus = (target: number) => {
          const next = sessions[Math.max(0, Math.min(sessions.length - 1, target))];
          if (next) refs.current.get(next.sessionId)?.focus();
        };
        const pressed = e.key;
        if (pressed === "ArrowDown") {
          e.preventDefault();
          focus(index + 1);
        } else if (pressed === "ArrowUp") {
          e.preventDefault();
          focus(index - 1);
        } else if (pressed === "Home") {
          e.preventDefault();
          focus(0);
        } else if (pressed === "End") {
          e.preventDefault();
          focus(sessions.length - 1);
        } else if (pressed === "Enter" || pressed === " ") {
          e.preventDefault();
          onSelect(id);
        } else if (pressed === "Escape") {
          onEscape();
        }
      },
    [sessions, onSelect, onEscape],
  );
  return { refs, handleKey };
}

interface ListboxProps extends Omit<SessionListProps, "active" | "ended"> {
  label: string;
  sessions: SessionView[];
  compact: boolean;
}

function Listbox({ label, sessions, compact, selectedId, nowMs, staleAfterMs, forceStale, updatedAt, onSelect, onEscape }: ListboxProps) {
  const { refs, handleKey } = useRovingList(sessions, onSelect, onEscape);
  const focusableId = sessions.some((s) => s.sessionId === selectedId) ? selectedId : (sessions[0]?.sessionId ?? null);
  return (
    <ul role="listbox" aria-label={label} className="flex flex-col gap-2">
      {sessions.map((session) => (
        <SessionCard
          key={session.sessionId}
          session={session}
          compact={compact}
          isStale={!compact && (forceStale || isStale(session, nowMs, staleAfterMs))}
          isSelected={session.sessionId === selectedId}
          isFocusable={session.sessionId === focusableId}
          nowMs={nowMs}
          updatedAt={updatedAt[session.sessionId]}
          onSelect={onSelect}
          onKeyDown={handleKey(session.sessionId)}
          cardRef={(node) => {
            if (node) refs.current.set(session.sessionId, node);
            else refs.current.delete(session.sessionId);
          }}
        />
      ))}
    </ul>
  );
}

export function SessionList({ active, ended, ...rest }: SessionListProps) {
  const endedOpen = useSyncExternalStore(subscribeEndedOpen, readEndedOpen, endedClosedOnServer);
  const toggleEnded = () => writeEndedOpen(!endedOpen);

  return (
    <div className="flex flex-col gap-4">
      {active.length > 0 && <Listbox label="Active sessions" sessions={active} compact={false} {...rest} />}
      {ended.length > 0 && (
        <section>
          <button
            type="button"
            className="flex items-center gap-1 text-sm text-muted hover:text-foreground"
            aria-expanded={endedOpen}
            aria-controls="ended-sessions"
            onClick={toggleEnded}
          >
            <ChevronIcon size={12} open={endedOpen} />
            Ended ({ended.length})
          </button>
          {endedOpen && (
            <div id="ended-sessions" className="mt-2">
              <Listbox label="Ended sessions" sessions={ended} compact {...rest} />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
