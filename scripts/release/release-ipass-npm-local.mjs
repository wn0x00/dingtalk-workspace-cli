import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const action = process.argv[2];
if (!new Set(["prepare", "publish"]).has(action)) {
  throw new Error("Usage: node scripts/release/release-ipass-npm-local.mjs <prepare|publish>");
}

const root = process.cwd();
const scope = (process.env.NPM_SCOPE || "@xiaojian-cli").trim();
const registry = "https://registry.npmjs.org/";
const upstream = readFileSync(join(root, "build/npm-ipass/upstream-version.txt"), "utf8").trim();
const version = (process.env.NPM_VERSION || `${upstream}-ipass.1`).trim();
const otp = (process.env.NPM_OTP || "").trim();
const name = `${scope}/dingtalk-workspace-cli`;
const out = join(root, ".release", "npm-local");
const artifacts = join(root, ".release", "artifacts");
const platforms = [
  { id: "darwin-arm64", os: "darwin", cpu: "arm64", binary: "dws" },
  { id: "linux-x64", os: "linux", cpu: "x64", binary: "dws" },
];

if (!/^@[a-z0-9][a-z0-9._-]*$/i.test(scope)) throw new Error(`Invalid NPM_SCOPE: ${scope}`);
if (!new RegExp(`^${upstream.replaceAll(".", "\\.")}-ipass\\.[1-9][0-9]*$`).test(version)) {
  throw new Error(`NPM_VERSION must be ${upstream}-ipass.<positive integer>`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function stage(platform, source) {
  if (!existsSync(source)) throw new Error(`Missing ${platform.id} binary: ${source}`);
  const dir = join(artifacts, `binary-${platform.id}`);
  mkdirSync(dir, { recursive: true });
  copyFileSync(source, join(dir, platform.binary));
  chmodSync(join(dir, platform.binary), 0o755);
}

function write(path, value) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function launcher() {
  const packages = Object.fromEntries(platforms.map((platform) => [platform.id, `${name}-${platform.id}`]));
  return `#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nimport { createRequire } from "node:module";\nimport { dirname, join } from "node:path";\nconst pkg = ${JSON.stringify(packages)}[\`${"${process.platform}-${process.arch}"}\`];\nif (!pkg) { console.error("Unsupported platform: " + process.platform + "-" + process.arch); process.exit(1); }\nconst require = createRequire(import.meta.url);\nlet manifest;\ntry { manifest = require.resolve(pkg + "/package.json"); } catch { console.error("Cannot find " + pkg + ". Reinstall ${name} without omitting optional dependencies."); process.exit(1); }\nconst result = spawnSync(join(dirname(manifest), "bin", "dws"), process.argv.slice(2), { env: process.env, stdio: "inherit" });\nif (result.error) { console.error(result.error.message); process.exit(1); }\nprocess.exit(result.status ?? 1);\n`;
}

if (action === "prepare") {
  run("go", ["build", "-buildmode=pie", "-trimpath", "-ldflags=-s -w", "-o", join(artifacts, "dws-darwin-arm64"), "./cmd"]);
  stage(platforms[0], join(artifacts, "dws-darwin-arm64"));
  run("docker", ["run", "--rm", "--platform=linux/amd64", "-v", `${root}:/workspace`, "-w", "/workspace", "golang:1.25-bookworm", "sh", "-c", "go build -trimpath -ldflags='-s -w' -o /workspace/.release/artifacts/dws-linux-x64 ./cmd"]);
  stage(platforms[1], join(artifacts, "dws-linux-x64"));

  rmSync(out, { recursive: true, force: true });
  const optionalDependencies = {};
  for (const platform of platforms) {
    const packageName = `${name}-${platform.id}`;
    optionalDependencies[packageName] = version;
    const dir = join(out, platform.id);
    mkdirSync(join(dir, "bin"), { recursive: true });
    copyFileSync(join(artifacts, `binary-${platform.id}`, platform.binary), join(dir, "bin", platform.binary));
    chmodSync(join(dir, "bin", platform.binary), 0o755);
    write(join(dir, "package.json"), { name: packageName, version, description: `${platform.id} binary for ${name}`, license: "Apache-2.0", files: ["bin"], os: [platform.os], cpu: [platform.cpu], publishConfig: { access: "public" } });
  }
  const rootDir = join(out, "root");
  mkdirSync(join(rootDir, "bin"), { recursive: true });
  writeFileSync(join(rootDir, "bin", "dws.js"), launcher());
  chmodSync(join(rootDir, "bin", "dws.js"), 0o755);
  write(join(rootDir, "package.json"), { name, version, description: "DingTalk Workspace CLI for Yingdao iPaaS", type: "module", bin: { dws: "bin/dws.js" }, files: ["bin"], optionalDependencies, publishConfig: { access: "public" }, engines: { node: ">=18" } });

  for (const dir of [...platforms.map((platform) => join(out, platform.id)), rootDir]) {
    run("npm", ["pack", dir, "--dry-run", `--registry=${registry}`]);
  }
  process.exit(0);
}
const rootDir = join(out, "root");
if (![...platforms.map((platform) => join(out, platform.id, "package.json")), join(rootDir, "package.json")].every(existsSync)) {
  throw new Error("Missing prepared npm packages; run npm run release:npm:prepare-local first");
}
run("npm", ["whoami", `--registry=${registry}`]);
for (const dir of [...platforms.map((platform) => join(out, platform.id)), rootDir]) {
  run("npm", [
    "publish",
    dir,
    "--access=public",
    "--tag=latest",
    `--registry=${registry}`,
    ...(otp ? [`--otp=${otp}`] : []),
  ]);
}
