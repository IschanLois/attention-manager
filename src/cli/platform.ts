export type SupportedPlatform = "linux" | "darwin";

export type PlatformCheck = { ok: true; platform: SupportedPlatform } | { ok: false; message: string };

export function isSupportedPlatform(platform: string): platform is SupportedPlatform {
  return platform === "linux" || platform === "darwin";
}

export function checkPlatform(platform: string): PlatformCheck {
  if (isSupportedPlatform(platform)) return { ok: true, platform };
  return { ok: false, message: `Unsupported platform "${platform}": only macOS and Linux are supported.` };
}
