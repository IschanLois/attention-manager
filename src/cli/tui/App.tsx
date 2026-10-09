import { useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { createClient } from "../client.ts";
import { describeFocusResult } from "../commands/focus.ts";
import { focusSession } from "../focus/select.ts";
import type { FocusContext } from "../focus/types.ts";
import { sessionLabel } from "../model/format.ts";
import type { HealthReport, SessionsSnapshot, SessionView } from "../model/types.ts";
import { connectStream, type StreamController } from "../sse.ts";
import { keyToCommand } from "./keys.ts";
import { Screen } from "./Screen.tsx";
import { initialState, reduce, selectedSession } from "./state.ts";
import type { Theme } from "./theme.ts";

const HEALTH_POLL_MS = 10_000;
const DETAIL_DEBOUNCE_MS = 150;

export interface AppProps {
  receiverUrl: string;
  theme: Theme;
  bell: boolean;
  classifierEnabled: boolean;
  focus: FocusContext;
  ringBell(): void;
}

function parse<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

export function App({ receiverUrl, theme, bell, classifierEnabled, focus, ringBell }: AppProps) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [state, dispatch] = useReducer(reduce, { bell }, initialState);
  const stream = useRef<StreamController | null>(null);
  const client = useRef(createClient(receiverUrl));
  const focusing = useRef(false);

  useEffect(() => {
    const controller = connectStream(receiverUrl, {
      onFrame(frame) {
        if (frame.event === "snapshot") {
          const snapshot = parse<SessionsSnapshot>(frame.data);
          if (snapshot) dispatch({ type: "snapshot", snapshot });
        } else if (frame.event === "session") {
          const session = parse<SessionView>(frame.data);
          if (session) dispatch({ type: "session", session, at: Date.now() });
        } else if (frame.event === "session_removed") {
          const removed = parse<{ sessionId: string }>(frame.data);
          if (removed) dispatch({ type: "removed", sessionId: removed.sessionId });
        } else if (frame.event === "health") {
          const health = parse<HealthReport>(frame.data);
          if (health) dispatch({ type: "health", health });
        }
      },
      onState(connection, retryAt) {
        dispatch({ type: "connection", connection, retryAt });
      },
    });
    stream.current = controller;
    return () => controller.close();
  }, [receiverUrl]);

  useEffect(() => {
    const poll = () => {
      client.current
        .health()
        .then((health) => dispatch({ type: "health", health }))
        .catch(() => undefined);
    };
    const timer = setInterval(poll, HEALTH_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => dispatch({ type: "tick", now: Date.now() }), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (state.bellCount > 0 && state.bell) ringBell();
  }, [state.bellCount, state.bell, ringBell]);

  const selected = selectedSession(state, state.now);
  const selectedId = selected?.sessionId ?? null;
  const selectedSeq = selected?.eventSeq ?? 0;
  useEffect(() => {
    if (!selectedId) return;
    const timer = setTimeout(() => {
      client.current
        .session(selectedId)
        .then((detail) => {
          if (detail) dispatch({ type: "detail-loaded", sessionId: selectedId, events: detail.events });
        })
        .catch(() => undefined);
    }, DETAIL_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [selectedId, selectedSeq]);

  const focusSelected = useCallback(
    (session: SessionView | null) => {
      if (!session || focusing.current) return;
      focusing.current = true;
      const name = sessionLabel(session.label, session.sessionId);
      dispatch({ type: "status", text: `Focusing ${name}${theme.glyphs.ellipsis}`, tone: "info", at: Date.now() });
      focusSession(session.terminal, focus)
        .then((result) => {
          const tone = result.kind === "focused" ? (result.notes.length ? "warn" : "success") : result.kind === "unsupported" ? "warn" : "error";
          dispatch({ type: "status", text: describeFocusResult(result, name), tone, at: Date.now(), ttlMs: 15_000 });
        })
        .catch((error: unknown) => dispatch({ type: "status", text: `Focus failed: ${(error as Error).message}`, tone: "error", at: Date.now() }))
        .finally(() => {
          focusing.current = false;
        });
    },
    [focus, theme],
  );

  useInput((input, key) => {
    const command = keyToCommand(input, key, state);
    if (!command) return;
    if ("action" in command) return dispatch(command.action);
    if (command.effect === "quit") return exit();
    if (command.effect === "reconnect") {
      dispatch({ type: "status", text: "Reconnecting to the receiver", tone: "info", at: Date.now(), ttlMs: 3000 });
      return stream.current?.reconnectNow();
    }
    focusSelected(selected);
  });

  return <Screen state={state} now={state.now} width={columns} height={rows} theme={theme} classifierEnabled={classifierEnabled} />;
}
