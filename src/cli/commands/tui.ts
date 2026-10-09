import { render } from "ink";
import { createElement } from "react";
import { EXIT_ERROR, EXIT_MISCONFIGURED, EXIT_OK } from "../args.ts";
import { focusContext, type CliContext } from "../context.ts";
import { ensureReceiver, LifecycleError, probeReceiver, spawnDetachedReceiver } from "../lifecycle.ts";
import { App } from "../tui/App.tsx";
import { createTheme, supportsUnicode } from "../tui/theme.ts";
import { reloadContext, runSetupCommand } from "./setup.ts";

const SHOW_CURSOR = "\u001b[?25h";
const LEAVE_ALT_SCREEN = "\u001b[?1049l";
const BELL = "\u0007";

// Ink restores the terminal on a normal exit or unmount; this covers crashes so the user's
// shell is never left in raw mode, without a cursor or on the alternate screen.
function restoreTerminal(): void {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {
    // stdin may already be closed
  }
  process.stdout.write(SHOW_CURSOR + LEAVE_ALT_SCREEN);
}

export async function runTui(ctx: CliContext, flags: { keepRunning: boolean; bell: boolean }): Promise<number> {
  if (!ctx.isTTY || !process.stdin.isTTY) {
    ctx.err("The attention UI needs an interactive terminal. Use `attention list` (or `attention list --json`) for scripts.");
    return EXIT_MISCONFIGURED;
  }

  let current = ctx;
  if (!current.configExists) {
    const code = await runSetupCommand(current, { yes: false });
    if (code !== EXIT_OK) return code;
    current = reloadContext(current);
  }

  try {
    await ensureReceiver({
      port: Number(new URL(current.receiverUrl).port),
      probe: () => probeReceiver(current.receiverUrl),
      spawn: () => spawnDetachedReceiver({ logFile: current.paths.receiverLog, env: current.env, exitWhenIdle: !flags.keepRunning }),
      logFile: current.paths.receiverLog,
    });
  } catch (error) {
    if (error instanceof LifecycleError) {
      current.err(error.message);
      return error.exitCode;
    }
    throw error;
  }

  const theme = createTheme({ color: current.color, unicode: supportsUnicode(current.env, current.platform) });
  const instance = render(
    createElement(App, {
      receiverUrl: current.receiverUrl,
      theme,
      bell: flags.bell && current.config.bell,
      classifierEnabled: current.config.classifier.enabled,
      focus: focusContext(current),
      ringBell: () => process.stdout.write(BELL),
    }),
    { alternateScreen: true, exitOnCtrlC: false, incrementalRendering: true, patchConsole: true },
  );

  const onSignal = () => instance.unmount();
  const onCrash = (error: unknown) => {
    try {
      instance.unmount();
    } finally {
      restoreTerminal();
      process.stderr.write(`attention crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exit(EXIT_ERROR);
    }
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  process.on("SIGINT", onSignal);
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);
  try {
    await instance.waitUntilExit();
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    process.off("SIGINT", onSignal);
  }
  return EXIT_OK;
}
