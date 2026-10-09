import { EXIT_ERROR, EXIT_MISCONFIGURED, EXIT_OK } from "../args.ts";
import { RECEIVER_NOT_RUNNING } from "../client.ts";
import { focusContext, type CliContext } from "../context.ts";
import { focusSession } from "../focus/select.ts";
import type { FocusResult } from "../focus/types.ts";
import { sessionLabel } from "../model/format.ts";
import { fetchSessions, matchSession } from "./list.ts";

export function describeFocusResult(result: FocusResult, name: string): string {
  switch (result.kind) {
    case "focused":
      return `Focused ${name} via ${result.via.join(" + ")}${result.notes.length ? ` (${result.notes.join("; ")})` : ""}`;
    case "unsupported":
      return `Can't focus ${name} automatically. ${result.hint}`;
    case "failed":
      return `Focusing ${name} failed: ${result.reason}. ${result.hint}`;
  }
}

export async function runFocus(ctx: CliContext, target: string): Promise<number> {
  const snapshot = await fetchSessions(ctx);
  if (!snapshot) {
    ctx.err(RECEIVER_NOT_RUNNING);
    return EXIT_ERROR;
  }
  const match = matchSession(snapshot.sessions, target);
  if (match.kind === "none") {
    ctx.err(`No session matches "${target}". Run \`attention list --all\` to see them.`);
    return EXIT_ERROR;
  }
  if (match.kind === "ambiguous") {
    ctx.err(`"${target}" matches more than one session: ${match.candidates.join(", ")}. Use a longer label or the session id.`);
    return EXIT_MISCONFIGURED;
  }
  const name = sessionLabel(match.session.label, match.session.sessionId);
  const result = await focusSession(match.session.terminal, focusContext(ctx));
  const message = describeFocusResult(result, name);
  if (result.kind === "focused") {
    ctx.out(message);
    return EXIT_OK;
  }
  ctx.err(message);
  return EXIT_ERROR;
}
