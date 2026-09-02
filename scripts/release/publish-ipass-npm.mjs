import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const rootPackageName = "@guanzhu.me/dingtalk-workspace-cli";
const platforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
];
const version = (process.env.NPM_VERSION || "").trim();
const outputRoot = resolve(
  process.env.DWS_NPM_OUTPUT_ROOT || join(process.cwd(), ".release", "npm"),
);
const registry = (process.env.NPM_REGISTRY_URL || "https://registry.npmjs.org").replace(
  /\/+$/,
  "",
);
const visibilityTimeoutMs = parsePositiveInteger(
  process.env.DWS_NPM_VISIBILITY_TIMEOUT_MS,
  20 * 60 * 1000,
  "DWS_NPM_VISIBILITY_TIMEOUT_MS",
);
const visibilityPollMs = parsePositiveInteger(
  process.env.DWS_NPM_VISIBILITY_POLL_MS,
  15 * 1000,
  "DWS_NPM_VISIBILITY_POLL_MS",
);

if (!/^\d+\.\d+\.\d+-ipass\.[1-9]\d*$/.test(version)) {
  throw new Error(
    `NPM_VERSION must look like <upstream>-ipass.<positive integer>; received ${JSON.stringify(version)}`,
  );
}

function parsePositiveInteger(raw, fallback, name) {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer; received ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function loadManifest(packageDir, expectedName) {
  const manifestPath = join(packageDir, "package.json");
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    throw new Error(`Missing package manifest: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== expectedName || manifest.version !== version) {
    throw new Error(
      `Unexpected package identity in ${manifestPath}: ${JSON.stringify({ name: manifest.name, version: manifest.version })}`,
    );
  }
  if (
    manifest.scripts !== undefined &&
    (typeof manifest.scripts !== "object" ||
      manifest.scripts === null ||
      Object.keys(manifest.scripts).length > 0)
  ) {
    throw new Error(`Publishing packages must not contain lifecycle scripts: ${manifestPath}`);
  }
  return manifest;
}

const packages = platforms.map((platform) => ({
  name: `${rootPackageName}-${platform}`,
  dir: join(outputRoot, platform),
}));
const rootPackage = { name: rootPackageName, dir: join(outputRoot, "root") };

for (const entry of [...packages, rootPackage]) {
  loadManifest(entry.dir, entry.name);
}
const rootManifest = loadManifest(rootPackage.dir, rootPackage.name);
for (const entry of packages) {
  if (rootManifest.optionalDependencies?.[entry.name] !== version) {
    throw new Error(
      `Root package must depend on ${entry.name}@${version}; received ${JSON.stringify(rootManifest.optionalDependencies?.[entry.name])}`,
    );
  }
}

console.log(`Validated seven npm staging packages for ${rootPackageName}@${version}.`);
if (process.env.DWS_NPM_PUBLISH_VALIDATE_ONLY === "1") {
  process.exit(0);
}

async function exactVersionIsVisible(packageName) {
  const packagePath = encodeURIComponent(packageName);
  // npm install resolves the full package index (packument), which can lag the
  // exact-version endpoint during registry propagation. Gate on the same index
  // so a successful workflow means a clean client can actually resolve it.
  const url = `${registry}/${packagePath}`;
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) return false;
    if (!response.ok) {
      console.warn(`Registry visibility check for ${packageName} returned HTTP ${response.status}.`);
      return false;
    }
    const packument = await response.json();
    return (
      packument.name === packageName &&
      packument.versions?.[version]?.version === version
    );
  } catch (error) {
    console.warn(
      `Registry visibility check for ${packageName} failed transiently: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

function printPublishOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function exactVersionStageState(packageName) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npmCommand,
    ["stage", "list", packageName, "--json", "--registry", registry],
    {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
      shell: process.platform === "win32",
    },
  );
  if (result.error || result.status !== 0) return "ERROR";
  try {
    const stages = JSON.parse(result.stdout || "null");
    if (!Array.isArray(stages)) return "ERROR";
    return stages.some(
      (stage) => stage?.packageName === packageName && stage?.version === version,
    )
      ? "STAGED"
      : "ABSENT";
  } catch {
    return "ERROR";
  }
}

function throwIfStaged(packageNames) {
  const staged = [];
  const errors = [];
  for (const packageName of packageNames) {
    const state = exactVersionStageState(packageName);
    if (state === "STAGED") staged.push(packageName);
    if (state === "ERROR") errors.push(packageName);
  }
  if (staged.length > 0) {
    throw new Error(
      `npm reports staged versions awaiting human approval: ${staged.map((name) => `${name}@${version}`).join(", ")}. Approve or reject them with npm 2FA before retrying.`,
    );
  }
  if (errors.length > 0) {
    console.warn(
      `Unable to determine npm staged state for: ${errors.join(", ")}. No raw stage metadata was logged.`,
    );
  }
}

async function publishIfMissing(entry) {
  if (await exactVersionIsVisible(entry.name)) {
    console.log(`Skipping ${entry.name}@${version}: already public.`);
    return;
  }

  console.log(`Publishing ${entry.name}@${version}...`);
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npmCommand,
    [
      "publish",
      entry.dir,
      "--access",
      "public",
      "--tag",
      "latest",
      "--ignore-scripts",
      "--registry",
      registry,
    ],
    {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
      shell: process.platform === "win32",
    },
  );
  printPublishOutput(result);

  if (result.error) throw result.error;
  if (result.status === 0) {
    console.log(
      `npm accepted ${entry.name}@${version}; continuing while the public registry propagates it.`,
    );
    return;
  }

  const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (/E409|EPUBLISHCONFLICT|cannot publish over|previously published/i.test(combinedOutput)) {
    throwIfStaged([entry.name]);
    console.log(
      `npm reports ${entry.name}@${version} is already reserved; the visibility gate will verify it.`,
    );
    return;
  }
  throw new Error(`npm publish failed for ${entry.name}@${version} with exit code ${result.status}.`);
}

async function waitUntilAllVisible(entries, label) {
  const deadline = Date.now() + visibilityTimeoutMs;
  let attempt = 0;
  while (true) {
    attempt += 1;
    const states = await Promise.all(
      entries.map(async (entry) => ({
        ...entry,
        visible: await exactVersionIsVisible(entry.name),
      })),
    );
    const missing = states.filter((state) => !state.visible);
    if (missing.length === 0) {
      console.log(`${label} visible in the public npm registry.`);
      return;
    }
    if (Date.now() >= deadline) {
      throwIfStaged(missing.map((entry) => entry.name));
      throw new Error(
        `${label} did not become public within ${Math.round(visibilityTimeoutMs / 1000)} seconds: ${missing.map((entry) => `${entry.name}@${version}`).join(", ")}`,
      );
    }
    console.log(
      `Waiting for npm propagation (attempt ${attempt}); still missing: ${missing.map((entry) => entry.name).join(", ")}`,
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, visibilityPollMs));
  }
}

// Platform packages are independent. Submit all of them before waiting so a slow
// npm registry propagation does not serialize six long visibility delays.
for (const entry of packages) {
  await publishIfMissing(entry);
}
await waitUntilAllVisible(packages, "All six platform packages");

// Publish the launcher only after every optional native dependency is installable.
await publishIfMissing(rootPackage);
await waitUntilAllVisible([rootPackage], "Root package");

console.log(`Published ${rootPackageName}@${version} and all six native packages.`);
