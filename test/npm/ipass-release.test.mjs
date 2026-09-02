import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const prepareScript = join(
  repoRoot,
  "scripts",
  "release",
  "prepare-ipass-npm-release.mjs",
);
const upstreamVersion = readFileSync(
  join(repoRoot, "build", "npm-ipass", "upstream-version.txt"),
  "utf8",
).trim();
const version = `${upstreamVersion}-ipass.1`;
const rootPackageName = "@guanzhu.me/dingtalk-workspace-cli";
const platforms = [
  { id: "darwin-arm64", os: "darwin", cpu: "arm64", binary: "dws" },
  { id: "darwin-x64", os: "darwin", cpu: "x64", binary: "dws" },
  { id: "linux-arm64", os: "linux", cpu: "arm64", binary: "dws" },
  { id: "linux-x64", os: "linux", cpu: "x64", binary: "dws" },
  { id: "win32-arm64", os: "win32", cpu: "arm64", binary: "dws.exe" },
  { id: "win32-x64", os: "win32", cpu: "x64", binary: "dws.exe" },
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function createFakeArtifacts(root) {
  for (const platform of platforms) {
    const path = join(root, `binary-${platform.id}`, platform.binary);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `fake ${platform.id} binary\n`);
    if (platform.os !== "win32") chmodSync(path, 0o755);
  }
}

test("prepares one root package and all platform packages", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "dws-ipass-npm-"));
  const artifactRoot = join(sandbox, "artifacts");
  const outputRoot = join(sandbox, "npm");
  try {
    createFakeArtifacts(artifactRoot);
    const result = spawnSync(process.execPath, [prepareScript], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DWS_NPM_ARTIFACT_ROOT: artifactRoot,
        DWS_NPM_OUTPUT_ROOT: outputRoot,
        NPM_VERSION: version,
      },
    });
    assert.equal(result.status, 0, result.stderr);

    const rootManifest = readJson(join(outputRoot, "root", "package.json"));
    assert.equal(rootManifest.name, rootPackageName);
    assert.equal(rootManifest.version, version);
    assert.deepEqual(rootManifest.bin, { dws: "bin/dws.js" });
    assert.equal(Object.keys(rootManifest.optionalDependencies).length, platforms.length);
    assert.equal(statSync(join(outputRoot, "root", "bin", "dws.js")).size > 0, true);

    for (const platform of platforms) {
      const packageName = `${rootPackageName}-${platform.id}`;
      assert.equal(rootManifest.optionalDependencies[packageName], version);
      const manifest = readJson(join(outputRoot, platform.id, "package.json"));
      assert.equal(manifest.name, packageName);
      assert.equal(manifest.version, version);
      assert.deepEqual(manifest.os, [platform.os]);
      assert.deepEqual(manifest.cpu, [platform.cpu]);
      assert.equal(
        statSync(join(outputRoot, platform.id, "bin", platform.binary)).size > 0,
        true,
      );
    }

    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const packRoot = join(sandbox, "packs");
    mkdirSync(packRoot, { recursive: true });
    // One real root pack verifies the launcher/manifest normalization locally.
    // CI packs all six platform packages plus this root package.
    const packed = spawnSync(
      npmCommand,
      [
        "pack",
        join(outputRoot, "root"),
        "--pack-destination",
        packRoot,
        "--json",
        "--ignore-scripts",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        shell: process.platform === "win32",
      },
    );
    assert.equal(packed.status, 0, packed.error?.message || packed.stderr);
    const packResult = JSON.parse(packed.stdout);
    assert.equal(packResult.length, 1);
    assert.match(packResult[0].integrity, /^sha512-/);
    assert.equal(existsSync(join(packRoot, packResult[0].filename)), true);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("rejects a version from a different upstream baseline", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "dws-ipass-npm-version-"));
  try {
    const parts = upstreamVersion.split(".").map(Number);
    const differentBaseline = `${parts[0]}.${parts[1]}.${parts[2] + 1}-ipass.1`;
    const result = spawnSync(process.execPath, [prepareScript], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DWS_NPM_ARTIFACT_ROOT: join(sandbox, "artifacts"),
        DWS_NPM_OUTPUT_ROOT: join(sandbox, "npm"),
        NPM_VERSION: differentBaseline,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`expected ${upstreamVersion.replaceAll(".", "\\.")}-ipass`));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
