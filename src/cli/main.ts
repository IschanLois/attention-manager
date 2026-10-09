#!/usr/bin/env node
import { EXIT_ERROR, EXIT_MISCONFIGURED, parseCli } from "./args.ts";
import { helpText } from "./help.ts";
import { VERSION } from "./meta.ts";
import { checkPlatform } from "./platform.ts";

// node:sqlite prints an ExperimentalWarning when it loads. Users of an installed CLI should
// not have to pass --no-warnings, so that one warning is filtered here, before any module
// that imports node:sqlite is loaded (they are all imported dynamically below).
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === "string" ? warning : warning.message;
  const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  if ((type === "ExperimentalWarning" || (warning as Error).name === "ExperimentalWarning") && /SQLite/i.test(message)) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

async function main(argv: string[]): Promise<number> {
  const parsed = parseCli(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\nRun \`attention --help\` for usage.\n`);
    return parsed.exitCode;
  }
  if (parsed.command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.command === "help") {
    process.stdout.write(helpText(parsed.topic) + "\n");
    return 0;
  }
  const platform = checkPlatform(process.platform);
  if (!platform.ok) {
    process.stderr.write(platform.message + "\n");
    return EXIT_MISCONFIGURED;
  }

  const { createContext } = await import("./context.ts");
  const ctx = createContext(platform.platform, parsed.flags.color);
  if (ctx.configError && parsed.command !== "setup" && parsed.command !== "doctor") {
    ctx.err(`${ctx.configError}\nFix the file or run \`attention setup\` to rewrite it.`);
    return EXIT_MISCONFIGURED;
  }

  switch (parsed.command) {
    case "list":
      return (await import("./commands/list.ts")).runList(ctx, parsed.flags);
    case "focus":
      return (await import("./commands/focus.ts")).runFocus(ctx, parsed.target);
    case "hooks":
      return (await import("./commands/hooks.ts")).runHooks(ctx, parsed.action);
    case "doctor":
      return (await import("./doctor.ts")).runDoctor(ctx, parsed.flags.json);
    case "receiver":
      return (await import("./commands/receiver.ts")).runReceiver(ctx, parsed.flags);
    case "setup":
      return (await import("./commands/setup.ts")).runSetupCommand(ctx, { yes: parsed.flags.yes });
    case "tui":
      return (await import("./commands/tui.ts")).runTui(ctx, parsed.flags);
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
    // Let pending output drain, but never hang on a stray handle once the command is done.
    setTimeout(() => process.exit(code), 2000).unref();
  })
  .catch((error: unknown) => {
    process.stderr.write(`attention: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT_ERROR;
  });
