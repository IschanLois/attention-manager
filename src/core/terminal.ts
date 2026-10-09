import { z } from "zod";

// Terminal identity arrives from the hook process environment and is later passed as
// arguments to focus commands, so every field is matched against a strict allow-list
// pattern; anything else is dropped rather than repaired.
const PATH = /^\/[A-Za-z0-9_./@+-]{1,255}$/;
const DIGITS = /^\d{1,9}$/;
const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

const pattern = (regex: RegExp) => z.string().regex(regex);
const optionalField = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const pid = z.number().int().min(2).max(2 ** 31 - 1);

export const TERMINAL_DISPLAYS = ["x11", "wayland", "macos"] as const;

export const terminalInfoSchema = z.object({
  termProgram: optionalField(pattern(/^[A-Za-z0-9_.+-]{1,64}$/)),
  tmux: optionalField(z.object({ socket: pattern(PATH), pane: pattern(/^%\d{1,7}$/) })),
  screen: optionalField(z.object({ sty: pattern(/^\d{1,10}\.[A-Za-z0-9_.-]{1,100}$/), window: optionalField(pattern(/^\d{1,4}$/)) })),
  kitty: optionalField(z.object({ windowId: pattern(DIGITS), listenOn: optionalField(pattern(/^(?:unix:@?|tcp:)[A-Za-z0-9_./:@+-]{1,255}$/)) })),
  wezterm: optionalField(z.object({ pane: pattern(DIGITS), socket: optionalField(pattern(PATH)) })),
  iterm: optionalField(z.object({ sessionId: pattern(/^w\d{1,4}t\d{1,4}p\d{1,4}:[0-9A-Fa-f-]{36}$/) })),
  appleTerminal: optionalField(z.object({ sessionId: pattern(UUID) })),
  alacritty: optionalField(z.object({ socket: pattern(PATH), windowId: optionalField(pattern(/^\d{1,20}$/)) })),
  windowId: optionalField(pattern(/^(?:0x[0-9A-Fa-f]{1,16}|\d{1,20})$/)),
  tty: optionalField(pattern(/^\/dev\/(?:pts\/\d{1,6}|tty[A-Za-z0-9]{1,16})$/)),
  pid: optionalField(pid),
  processName: optionalField(pattern(/^[A-Za-z0-9_.+-]{1,32}$/)),
  ancestors: optionalField(z.array(pid).max(12)),
  cwd: optionalField(z.string().regex(/^\/[^\u0000-\u001f\u007f]{0,1023}$/)),
  display: optionalField(z.enum(TERMINAL_DISPLAYS)),
});

export type TerminalInfo = z.infer<typeof terminalInfoSchema>;

function compact<T>(value: T): T {
  if (Array.isArray(value) || value === null || typeof value !== "object") return value;
  const entries = Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, compact(v)]);
  return Object.fromEntries(entries) as T;
}

export function sanitizeTerminal(raw: unknown): TerminalInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const parsed = terminalInfoSchema.safeParse(raw);
  if (!parsed.success) return null;
  const info = compact(parsed.data);
  return Object.keys(info).length > 0 ? info : null;
}
