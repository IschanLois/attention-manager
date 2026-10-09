import { describe, expect, it } from "vitest";
import { resolvePaths, UnsupportedPlatformError } from "@/cli/paths";
import { checkPlatform } from "@/cli/platform";

const HOME = "/home/ada";

describe("resolvePaths", () => {
  it("uses XDG defaults under the home directory on Linux", () => {
    const paths = resolvePaths({ platform: "linux", env: {}, home: HOME, appName: "attention-manager" });
    expect(paths.configDir).toBe("/home/ada/.config/attention-manager");
    expect(paths.stateDir).toBe("/home/ada/.local/state/attention-manager");
    expect(paths.logDir).toBe("/home/ada/.local/state/attention-manager/logs");
    expect(paths.configFile).toBe("/home/ada/.config/attention-manager/config.json");
    expect(paths.tokenFile).toBe("/home/ada/.config/attention-manager/ingest-token");
    expect(paths.headerFile).toBe("/home/ada/.config/attention-manager/ingest-header");
    expect(paths.databaseFile).toBe("/home/ada/.local/state/attention-manager/attention.db");
    expect(paths.receiverLog).toBe("/home/ada/.local/state/attention-manager/logs/receiver.log");
  });

  it("honours absolute XDG_CONFIG_HOME and XDG_STATE_HOME", () => {
    const paths = resolvePaths({ platform: "linux", env: { XDG_CONFIG_HOME: "/cfg", XDG_STATE_HOME: "/state" }, home: HOME, appName: "am" });
    expect(paths.configDir).toBe("/cfg/am");
    expect(paths.stateDir).toBe("/state/am");
  });

  it("ignores relative XDG values as the spec requires", () => {
    const paths = resolvePaths({ platform: "linux", env: { XDG_CONFIG_HOME: "relative/cfg" }, home: HOME, appName: "am" });
    expect(paths.configDir).toBe("/home/ada/.config/am");
  });

  it("uses Application Support and Logs on macOS", () => {
    const paths = resolvePaths({ platform: "darwin", env: {}, home: "/Users/ada", appName: "am" });
    expect(paths.configDir).toBe("/Users/ada/Library/Application Support/am");
    expect(paths.stateDir).toBe("/Users/ada/Library/Application Support/am");
    expect(paths.logDir).toBe("/Users/ada/Library/Logs/am");
    expect(paths.databaseFile).toBe("/Users/ada/Library/Application Support/am/attention.db");
  });

  it("lets explicit XDG variables win on macOS too", () => {
    const paths = resolvePaths({ platform: "darwin", env: { XDG_CONFIG_HOME: "/x/cfg", XDG_STATE_HOME: "/x/state" }, home: "/Users/ada", appName: "am" });
    expect(paths.configDir).toBe("/x/cfg/am");
    expect(paths.stateDir).toBe("/x/state/am");
    expect(paths.logDir).toBe("/x/state/am/logs");
  });

  it("lets ATTENTION_CONFIG_DIR, ATTENTION_STATE_DIR, DATABASE_PATH and INGEST_TOKEN_PATH override", () => {
    const paths = resolvePaths({
      platform: "linux",
      env: { ATTENTION_CONFIG_DIR: "/c", ATTENTION_STATE_DIR: "/s", DATABASE_PATH: "/db/x.db", INGEST_TOKEN_PATH: "/t/token" },
      home: HOME,
      appName: "am",
    });
    expect(paths.configDir).toBe("/c");
    expect(paths.stateDir).toBe("/s");
    expect(paths.databaseFile).toBe("/db/x.db");
    expect(paths.tokenFile).toBe("/t/token");
    expect(paths.headerFile).toBe("/t/ingest-header");
  });

  it("rejects Windows", () => {
    expect(() => resolvePaths({ platform: "win32", env: {}, home: "C:\\Users\\ada", appName: "am" })).toThrow(UnsupportedPlatformError);
  });
});

describe("checkPlatform", () => {
  it("accepts Linux and macOS", () => {
    expect(checkPlatform("linux").ok).toBe(true);
    expect(checkPlatform("darwin").ok).toBe(true);
  });

  it("refuses Windows with a clear message", () => {
    const result = checkPlatform("win32");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/unsupported platform/i);
  });
});
