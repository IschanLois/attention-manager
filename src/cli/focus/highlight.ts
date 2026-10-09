import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { StepOutcome } from "./types.ts";

const BEL = "\x07";

export async function writeTty(tty: string, data: string): Promise<StepOutcome> {
  let handle;
  try {
    handle = await open(tty, constants.O_WRONLY | constants.O_NOCTTY | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isCharacterDevice()) return { ok: false, reason: `${tty} is not a terminal` };
    if (process.getuid && stat.uid !== process.getuid()) return { ok: false, reason: `${tty} belongs to another user` };
    await handle.write(data);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  } finally {
    await handle?.close();
  }
}

export function ringTty(tty: string): Promise<StepOutcome> {
  return writeTty(tty, BEL);
}
