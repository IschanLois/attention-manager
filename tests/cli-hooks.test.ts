import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureToken, HOOK_EVENTS, hookCommand, hookStatus, isOurHook, planInstall, planUninstall, readSettings, writeSettings } from "@/cli/hooks";

const SPEC = { nodePath: "/usr/bin/node", hookScript: "/usr/lib/node_modules/attention-manager/dist/hook/main.js" };
const COMMAND = '"/usr/bin/node" "/usr/lib/node_modules/attention-manager/dist/hook/main.js"';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "attention-hooks-"));
}

describe("hookCommand", () => {
  it("quotes the node binary and the hook entry", () => {
    expect(hookCommand(SPEC)).toBe(COMMAND);
    expect(hookCommand({ nodePath: "/Users/ada/Library/Application Support/n/node", hookScript: "/x/dist/hook/main.js" })).toBe(
      '"/Users/ada/Library/Application Support/n/node" "/x/dist/hook/main.js"',
    );
  });

  it("refuses paths that would break out of the quotes", () => {
    expect(() => hookCommand({ nodePath: '/usr/bin/no"de', hookScript: SPEC.hookScript })).toThrow();
    expect(() => hookCommand({ nodePath: "/usr/bin/node", hookScript: "/x/$(id)/main.js" })).toThrow();
    expect(() => hookCommand({ nodePath: "/usr/bin/node", hookScript: "/x/`id`/main.js" })).toThrow();
  });
});

describe("isOurHook", () => {
  it("recognises the packaged entry, the source entry and the legacy shell forwarder", () => {
    expect(isOurHook(COMMAND)).toBe(true);
    expect(isOurHook('"/usr/bin/node" "/home/ada/attention/src/hook/main.ts"')).toBe(true);
    expect(isOurHook("/home/ada/attention/scripts/claude-hook.sh")).toBe(true);
    expect(isOurHook("/home/ada/bin/my-hook.sh")).toBe(false);
    expect(isOurHook('node "/somewhere/dist/other/main.js"')).toBe(false);
  });
});

describe("planInstall", () => {
  it("adds one group per event after the user's own hooks and reports what changed", () => {
    const userGroup = { matcher: "Bash", hooks: [{ type: "command", command: "/home/ada/bin/audit.sh" }] };
    const plan = planInstall({ theme: "dark", hooks: { PreToolUse: [userGroup] } }, COMMAND);
    expect(plan.added).toEqual([...HOOK_EVENTS]);
    expect(plan.replaced).toEqual([]);
    expect(plan.settings.theme).toBe("dark");
    expect(plan.settings.hooks!.PreToolUse).toEqual([userGroup, { hooks: [{ type: "command", command: COMMAND, timeout: 5 }] }]);
    for (const event of HOOK_EVENTS) expect(plan.settings.hooks![event]!.at(-1)).toEqual({ hooks: [{ type: "command", command: COMMAND, timeout: 5 }] });
  });

  it("replaces a legacy or stale install instead of duplicating it", () => {
    const legacy = { hooks: { Stop: [{ hooks: [{ type: "command", command: "/old/scripts/claude-hook.sh", timeout: 5 }] }] } };
    const plan = planInstall(legacy, COMMAND);
    expect(plan.replaced).toEqual(["Stop"]);
    expect(plan.settings.hooks!.Stop).toEqual([{ hooks: [{ type: "command", command: COMMAND, timeout: 5 }] }]);
  });

  it("is a no-op when already installed", () => {
    const once = planInstall({}, COMMAND).settings;
    const twice = planInstall(once, COMMAND);
    expect(twice.unchanged).toBe(true);
    expect(twice.settings).toEqual(once);
  });
});

describe("planUninstall", () => {
  it("removes only our hooks and drops the hooks key when nothing else is left", () => {
    const installed = planInstall({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/a.sh" }] }] } }, COMMAND).settings;
    const plan = planUninstall(installed);
    expect(plan.removed).toEqual([...HOOK_EVENTS]);
    expect(plan.settings.hooks).toEqual({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/a.sh" }] }] });
    expect(planUninstall(planInstall({}, COMMAND).settings).settings).toEqual({});
  });
});

describe("hookStatus", () => {
  const exists = () => true;

  it("reports installed when every event runs the expected command", () => {
    expect(hookStatus(planInstall({}, COMMAND).settings, COMMAND, exists)).toMatchObject({ state: "installed", events: [...HOOK_EVENTS] });
  });

  it("reports absent, partial and stale installs", () => {
    expect(hookStatus({}, COMMAND, exists).state).toBe("absent");
    const partial = { hooks: { Stop: [{ hooks: [{ type: "command", command: COMMAND }] }] } };
    expect(hookStatus(partial, COMMAND, exists).state).toBe("partial");
    const moved = planInstall({}, '"/usr/bin/node" "/old/prefix/attention-manager/dist/hook/main.js"').settings;
    const stale = hookStatus(moved, COMMAND, exists);
    expect(stale.state).toBe("stale");
    expect(stale.reason).toMatch(/different/);
    const legacy = planInstall({}, "/repo/scripts/claude-hook.sh").settings;
    expect(hookStatus(legacy, COMMAND, exists).state).toBe("stale");
  });

  it("reports stale when the installed hook file no longer exists", () => {
    const status = hookStatus(planInstall({}, COMMAND).settings, COMMAND, () => false);
    expect(status.state).toBe("stale");
    expect(status.reason).toMatch(/missing/);
  });
});

describe("settings files and tokens", () => {
  it("backs up the original once and writes atomically", () => {
    const dir = tempDir();
    const file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ original: true }));
    writeSettings(file, { first: true });
    writeSettings(file, { second: true });
    expect(JSON.parse(readFileSync(`${file}.attention-backup`, "utf8"))).toEqual({ original: true });
    expect(readSettings(file)).toEqual({ second: true });
    expect(existsSync(`${file}.attention-tmp`)).toBe(false);
  });

  it("treats a missing or empty settings file as empty and rejects non-objects", () => {
    const dir = tempDir();
    expect(readSettings(join(dir, "missing.json"))).toEqual({});
    writeFileSync(join(dir, "empty.json"), "  ");
    expect(readSettings(join(dir, "empty.json"))).toEqual({});
    writeFileSync(join(dir, "array.json"), "[]");
    expect(() => readSettings(join(dir, "array.json"))).toThrow(/not a JSON object/);
  });

  it("creates a 0600 token and header file once and then reuses them", () => {
    const dir = join(tempDir(), "cfg");
    const paths = { tokenFile: join(dir, "ingest-token"), headerFile: join(dir, "ingest-header") };
    const first = ensureToken(paths);
    expect(first.created).toBe(true);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(statSync(paths.tokenFile).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(paths.headerFile, "utf8")).toBe(`x-attention-token: ${first.token}\n`);
    expect(ensureToken(paths)).toEqual({ token: first.token, created: false });
  });
});
