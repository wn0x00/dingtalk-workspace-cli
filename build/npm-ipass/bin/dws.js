#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

const platformPackages = Object.freeze({
  "darwin-arm64": "@guanzhu.me/dingtalk-workspace-cli-darwin-arm64",
  "darwin-x64": "@guanzhu.me/dingtalk-workspace-cli-darwin-x64",
  "linux-arm64": "@guanzhu.me/dingtalk-workspace-cli-linux-arm64",
  "linux-x64": "@guanzhu.me/dingtalk-workspace-cli-linux-x64",
  "win32-arm64": "@guanzhu.me/dingtalk-workspace-cli-win32-arm64",
  "win32-x64": "@guanzhu.me/dingtalk-workspace-cli-win32-x64",
});

const platformKey = `${process.platform}-${process.arch}`;
const platformPackage = platformPackages[platformKey];

if (!platformPackage) {
  console.error(
    `Unsupported platform ${platformKey}. Supported platforms: ${Object.keys(platformPackages).join(", ")}`,
  );
  process.exit(1);
}

let manifestPath;
try {
  manifestPath = require.resolve(`${platformPackage}/package.json`);
} catch {
  console.error(
    `Cannot find the DWS binary package ${platformPackage}. Reinstall @guanzhu.me/dingtalk-workspace-cli without disabling optional dependencies.`,
  );
  process.exit(1);
}

const binaryName = process.platform === "win32" ? "dws.exe" : "dws";
const binaryPath = join(dirname(manifestPath), "bin", binaryName);
const result = spawnSync(binaryPath, process.argv.slice(2), {
  env: process.env,
  stdio: "inherit",
  windowsHide: false,
});

if (result.error) {
  console.error(`Failed to start DWS: ${result.error.message}`);
  process.exit(1);
}

if (result.signal && process.platform !== "win32") {
  process.kill(process.pid, result.signal);
}

process.exit(result.status ?? 1);
