import { EXIT_ERROR, EXIT_MISCONFIGURED, EXIT_OK, type HookAction } from "../args.ts";
import type { CliContext } from "../context.ts";
import { ensureToken, hookCommand, hookStatus, planInstall, planUninstall, readSettings, writeSettings } from "../hooks.ts";

export function installHooks(ctx: CliContext): { added: string[]; replaced: string[]; unchanged: boolean } {
  ensureToken(ctx.paths);
  const plan = planInstall(readSettings(ctx.settingsPath), hookCommand(ctx.hookSpec));
  if (!plan.unchanged) writeSettings(ctx.settingsPath, plan.settings);
  return plan;
}

export async function runHooks(ctx: CliContext, action: HookAction): Promise<number> {
  try {
    if (action === "install") {
      const plan = installHooks(ctx);
      if (plan.unchanged) ctx.out(`Hooks are already installed in ${ctx.settingsPath}.`);
      else {
        ctx.out(`Installed hooks for ${plan.added.length + plan.replaced.length} events in ${ctx.settingsPath}` + (plan.replaced.length ? ` (replaced an older install for ${plan.replaced.length}).` : "."));
        ctx.out(`A backup of the original settings is kept at ${ctx.settingsPath}.attention-backup.`);
      }
      ctx.out("Restart running Claude Code sessions to pick up the hooks.");
      return EXIT_OK;
    }
    if (action === "uninstall") {
      const plan = planUninstall(readSettings(ctx.settingsPath));
      if (plan.removed.length) writeSettings(ctx.settingsPath, plan.settings);
      ctx.out(plan.removed.length ? `Removed hooks for ${plan.removed.length} events from ${ctx.settingsPath}.` : "No attention hooks were installed.");
      return EXIT_OK;
    }
    const status = hookStatus(readSettings(ctx.settingsPath), hookCommand(ctx.hookSpec));
    ctx.out(`Settings file: ${ctx.settingsPath}`);
    ctx.out(`Hook command:  ${hookCommand(ctx.hookSpec)}`);
    ctx.out(`Status:        ${status.state}${status.reason ? ` (${status.reason})` : ""}`);
    if (status.events.length) ctx.out(`Events:        ${status.events.join(", ")}`);
    return status.state === "installed" ? EXIT_OK : EXIT_MISCONFIGURED;
  } catch (error) {
    ctx.err(`hooks ${action} failed: ${(error as Error).message}`);
    return EXIT_ERROR;
  }
}
