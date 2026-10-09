import { configSchema, DEFAULT_MODEL, DEFAULT_OLLAMA_URL, type CliConfig } from "./config.ts";
import type { FocusResult } from "./focus/types.ts";

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

// Every question resolves to null when the user cancels (Ctrl-C / Esc).
export interface Prompter {
  intro(text: string): void;
  note(text: string, title?: string): void;
  info(text: string): void;
  warn(text: string): void;
  success(text: string): void;
  outro(text: string): void;
  confirm(message: string, initial: boolean): Promise<boolean | null>;
  select(message: string, options: SelectOption[], initial: string): Promise<string | null>;
  text(message: string, initial: string, validate?: (value: string) => string | undefined): Promise<string | null>;
}

export interface SetupDeps {
  prompter: Prompter;
  yes: boolean;
  existing: CliConfig;
  platform: string;
  hooks: {
    settingsPath: string;
    plan(): { added: string[]; replaced: string[]; unchanged: boolean };
    install(): void;
  };
  ensureToken(): void;
  probeOllama(url: string, model: string): Promise<{ reachable: boolean; modelInstalled: boolean }>;
  terminal: { backends: string[]; wayland: boolean; testFocus(): Promise<FocusResult> };
  save(config: CliConfig): void;
}

export type SetupResult = { ok: true; config: CliConfig } | { ok: false; cancelled: true };

class Cancelled extends Error {}

function answered<T>(value: T | null): T {
  if (value === null) throw new Cancelled();
  return value;
}

function validUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? undefined : "Use an http(s) URL";
  } catch {
    return "Enter a URL such as http://127.0.0.1:11434";
  }
}

async function askHooks({ prompter, yes, hooks }: SetupDeps): Promise<void> {
  const plan = hooks.plan();
  if (plan.unchanged) {
    prompter.info(`Claude Code hooks are already installed in ${hooks.settingsPath}.`);
    return;
  }
  const changes = [plan.added.length ? `adds ${plan.added.length} events` : "", plan.replaced.length ? `updates ${plan.replaced.length} from an older install` : ""].filter(Boolean).join(", ");
  const install = yes || answered(await prompter.confirm(`Install the Claude Code hooks into ${hooks.settingsPath}? (${changes}; your own hooks are kept and a backup is made)`, true));
  if (install) {
    hooks.install();
    prompter.success("Hooks installed. Restart running `claude` sessions to pick them up.");
  } else prompter.warn("Skipped. Sessions will not appear until you run `attention hooks install`.");
}

async function askClassifier({ prompter, yes, existing, probeOllama }: SetupDeps): Promise<CliConfig["classifier"]> {
  const current = existing.classifier;
  const isDefault = current.ollamaUrl === DEFAULT_OLLAMA_URL && current.model === DEFAULT_MODEL;
  const initial = !current.enabled ? "off" : isDefault ? "default" : "custom";
  const choice = yes
    ? "default"
    : answered(
        await prompter.select(
          "Use a local AI model (Ollama) to classify ambiguous events? Nothing leaves this machine.",
          [
            { value: "default", label: `Yes, ${DEFAULT_MODEL} at ${DEFAULT_OLLAMA_URL}`, hint: "recommended" },
            { value: "custom", label: "Yes, with a different URL or model", hint: isDefault ? undefined : `${current.model} at ${current.ollamaUrl}` },
            { value: "off", label: "No, rule-based only" },
          ],
          initial,
        ),
      );
  if (choice === "off") return { ...current, enabled: false };

  let ollamaUrl = DEFAULT_OLLAMA_URL;
  let model = DEFAULT_MODEL;
  if (choice === "custom") {
    ollamaUrl = answered(await prompter.text("Ollama URL", current.ollamaUrl, validUrl)).trim().replace(/\/+$/, "");
    model = answered(await prompter.text("Model", current.model, (v) => (v.trim() ? undefined : "Enter a model name"))).trim();
  }
  const probe = await probeOllama(ollamaUrl, model);
  if (!probe.reachable) prompter.warn(`Ollama is not reachable at ${ollamaUrl}. Classification stays rule-based until it is running (ollama serve).`);
  else if (!probe.modelInstalled) prompter.warn(`${model} is not installed. Pull it with:\n  ollama pull ${model}`);
  else prompter.success(`${model} is available.`);
  return { enabled: true, ollamaUrl, model };
}

async function askTerminal({ prompter, yes, platform, terminal }: SetupDeps): Promise<string | null> {
  if (terminal.backends.length === 0) {
    prompter.note(
      terminal.wayland
        ? "No focus route was found for this terminal. Wayland has no generic window-focus API, so run Claude inside tmux or screen, or use kitty (allow_remote_control) or WezTerm. Other sessions will show a manual hint."
        : "No focus route was found for this terminal. Run Claude inside tmux, or install xdotool or wmctrl. Other sessions will show a manual hint.",
      "Terminal focus",
    );
    return null;
  }
  const detected = terminal.backends.join(" + ");
  if (platform === "darwin" && terminal.backends.some((b) => b === "iterm" || b === "apple-terminal")) {
    prompter.note("macOS will ask once to let your terminal control iTerm2 or Terminal (System Settings → Privacy & Security → Automation). Allow it to enable focus.", "Automation permission");
  }
  if (!yes && answered(await prompter.confirm(`Detected ${detected}. Test focusing this terminal now?`, true))) {
    const result = await terminal.testFocus();
    if (result.kind === "focused") prompter.success(`Focus works via ${result.via.join(" + ")}.`);
    else prompter.warn(result.kind === "failed" ? `Focus failed: ${result.reason}. ${result.hint}` : result.hint);
  }
  return terminal.backends.join("+");
}

export async function runSetup(deps: SetupDeps): Promise<SetupResult> {
  const { prompter } = deps;
  prompter.intro("attention setup");
  try {
    deps.ensureToken();
    await askHooks(deps);
    const classifier = await askClassifier(deps);
    const confirmed = await askTerminal(deps);
    const config = configSchema.parse({ ...deps.existing, classifier, terminal: { confirmed } });
    deps.save(config);
    prompter.outro("Setup complete. Run `attention` to open the UI, or `attention setup` again to change these answers.");
    return { ok: true, config };
  } catch (error) {
    if (error instanceof Cancelled) {
      prompter.outro("Setup cancelled; the configuration was not saved.");
      return { ok: false, cancelled: true };
    }
    throw error;
  }
}
