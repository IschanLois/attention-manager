import { parseArgs, type ParseArgsConfig } from "node:util";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_MISCONFIGURED = 2;

export const COMMANDS = ["tui", "setup", "doctor", "hooks", "receiver", "list", "focus", "help", "version"] as const;
export type CommandName = (typeof COMMANDS)[number];
export const HOOK_ACTIONS = ["install", "uninstall", "status"] as const;
export type HookAction = (typeof HOOK_ACTIONS)[number];

export interface GlobalFlags {
  color: boolean;
}

export type ParsedCli =
  | { ok: true; command: "tui"; flags: GlobalFlags & { keepRunning: boolean; bell: boolean } }
  | { ok: true; command: "setup"; flags: GlobalFlags & { yes: boolean } }
  | { ok: true; command: "doctor"; flags: GlobalFlags & { json: boolean } }
  | { ok: true; command: "hooks"; action: HookAction; flags: GlobalFlags }
  | { ok: true; command: "receiver"; flags: GlobalFlags & { port: number | null; exitWhenIdle: boolean } }
  | { ok: true; command: "list"; flags: GlobalFlags & ListFlags }
  | { ok: true; command: "focus"; target: string; flags: GlobalFlags }
  | { ok: true; command: "help"; topic: string | null; flags: GlobalFlags }
  | { ok: true; command: "version"; flags: GlobalFlags }
  | { ok: false; error: string; exitCode: 2 };

export interface ListFlags {
  json: boolean;
  status?: string;
  minPriority?: string;
  minRisk?: string;
  sort?: string;
  all: boolean;
}

type Options = NonNullable<ParseArgsConfig["options"]>;

const GLOBAL: Options = {
  "no-color": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
};

const COMMAND_OPTIONS: Record<CommandName, Options> = {
  tui: { "keep-running": { type: "boolean" }, "no-bell": { type: "boolean" } },
  setup: { yes: { type: "boolean", short: "y" } },
  doctor: { json: { type: "boolean" } },
  hooks: {},
  receiver: { port: { type: "string" }, "exit-when-idle": { type: "boolean" } },
  list: {
    json: { type: "boolean" },
    status: { type: "string" },
    "min-priority": { type: "string" },
    "min-risk": { type: "string" },
    sort: { type: "string" },
    all: { type: "boolean", short: "a" },
  },
  focus: {},
  help: {},
  version: {},
};

const MAX_POSITIONALS: Record<CommandName, number> = { tui: 0, setup: 0, doctor: 0, hooks: 1, receiver: 0, list: 0, focus: 1, help: 1, version: 0 };

function fail(error: string): ParsedCli {
  return { ok: false, error, exitCode: EXIT_MISCONFIGURED };
}

export function parseCli(argv: string[]): ParsedCli {
  const first = argv[0];
  const named = first !== undefined && !first.startsWith("-");
  if (named && !(COMMANDS as readonly string[]).includes(first)) return fail(`unknown command "${first}"; run with --help for usage`);
  const command: CommandName = named ? (first as CommandName) : "tui";
  const rest = named ? argv.slice(1) : argv;

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: rest, options: { ...GLOBAL, ...COMMAND_OPTIONS[command] }, allowPositionals: true, strict: true });
  } catch (error) {
    return fail((error as Error).message);
  }
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const positionals = parsed.positionals;
  const flags: GlobalFlags = { color: !values["no-color"] };

  if (values.version) return { ok: true, command: "version", flags };
  if (values.help) return { ok: true, command: "help", topic: named && command !== "help" ? command : (positionals[0] ?? null), flags };
  if (positionals.length > MAX_POSITIONALS[command]) return fail(`unexpected argument "${positionals.at(-1)}" for ${command}`);

  switch (command) {
    case "tui":
      return { ok: true, command, flags: { ...flags, keepRunning: Boolean(values["keep-running"]), bell: !values["no-bell"] } };
    case "setup":
      return { ok: true, command, flags: { ...flags, yes: Boolean(values.yes) } };
    case "doctor":
      return { ok: true, command, flags: { ...flags, json: Boolean(values.json) } };
    case "hooks": {
      const action = positionals[0] ?? "status";
      if (!(HOOK_ACTIONS as readonly string[]).includes(action)) return fail(`unknown hooks action "${action}"; expected ${HOOK_ACTIONS.join(", ")}`);
      return { ok: true, command, action: action as HookAction, flags };
    }
    case "receiver": {
      const rawPort = values.port as string | undefined;
      const port = rawPort === undefined ? null : Number(rawPort);
      if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return fail(`invalid --port "${rawPort}"`);
      return { ok: true, command, flags: { ...flags, port, exitWhenIdle: Boolean(values["exit-when-idle"]) } };
    }
    case "list":
      return {
        ok: true,
        command,
        flags: {
          ...flags,
          json: Boolean(values.json),
          status: values.status as string | undefined,
          minPriority: values["min-priority"] as string | undefined,
          minRisk: values["min-risk"] as string | undefined,
          sort: values.sort as string | undefined,
          all: Boolean(values.all),
        },
      };
    case "focus":
      if (!positionals[0]) return fail("focus needs a session id or label");
      return { ok: true, command, target: positionals[0], flags };
    case "help":
      return { ok: true, command, topic: positionals[0] ?? null, flags };
    case "version":
      return { ok: true, command, flags };
  }
}
