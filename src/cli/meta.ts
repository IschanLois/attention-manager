import { readFileSync } from "node:fs";

interface PackageJson {
  name: string;
  version: string;
  bin?: Record<string, string>;
}

// package.json is the single place the package and binary names are defined; this file
// sits two levels below the package root both in src/ and in the built dist/.
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as PackageJson;

export const PACKAGE_NAME = pkg.name;
export const APP_NAME = pkg.name.replace(/^@[^/]+\//, "");
export const VERSION = pkg.version;
export const BIN_NAME = Object.keys(pkg.bin ?? {})[0] ?? APP_NAME;
