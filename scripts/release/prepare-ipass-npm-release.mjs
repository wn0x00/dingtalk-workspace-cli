import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(process.env.DWS_NPM_REPO_ROOT || process.cwd());
const artifactRoot = resolve(
  process.env.DWS_NPM_ARTIFACT_ROOT || join(repoRoot, ".release", "artifacts"),
);
const outputRoot = resolve(
  process.env.DWS_NPM_OUTPUT_ROOT || join(repoRoot, ".release", "npm"),
);

const rootPackageName = "@guanzhu.me/dingtalk-workspace-cli";
const repository = {
  type: "git",
  url: "git+https://github.com/wn0x00/dingtalk-workspace-cli.git",
};
const upstreamVersionFile = join(
  repoRoot,
  "build",
  "npm-ipass",
  "upstream-version.txt",
);
const upstreamVersion = readFileSync(upstreamVersionFile, "utf8").trim();
if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(upstreamVersion)) {
  throw new Error(
    `Invalid upstream DWS version in ${upstreamVersionFile}: ${JSON.stringify(upstreamVersion)}`,
  );
}
const defaultVersion = `${upstreamVersion}-ipass.1`;
const version = (process.env.NPM_VERSION || defaultVersion).trim();
const versionPattern = new RegExp(
  `^${upstreamVersion.replaceAll(".", "\\.")}-ipass\\.[1-9][0-9]*$`,
);

if (!versionPattern.test(version)) {
  throw new Error(
    `Invalid custom DWS npm version ${JSON.stringify(version)}; expected ${upstreamVersion}-ipass.<positive integer>`,
  );
}

const platforms = [
  { id: "darwin-arm64", os: "darwin", cpu: "arm64", binary: "dws" },
  { id: "darwin-x64", os: "darwin", cpu: "x64", binary: "dws" },
  { id: "linux-arm64", os: "linux", cpu: "arm64", binary: "dws" },
  { id: "linux-x64", os: "linux", cpu: "x64", binary: "dws" },
  { id: "win32-arm64", os: "win32", cpu: "arm64", binary: "dws.exe" },
  { id: "win32-x64", os: "win32", cpu: "x64", binary: "dws.exe" },
];

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function requireFile(path, description) {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    throw new Error(`Missing ${description}: ${path}`);
  }
}

function copyLegalFiles(targetDir) {
  for (const name of ["LICENSE", "NOTICE"]) {
    const source = join(repoRoot, name);
    requireFile(source, name);
    copyFileSync(source, join(targetDir, name));
  }
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

const optionalDependencies = {};

for (const platform of platforms) {
  const packageName = `${rootPackageName}-${platform.id}`;
  optionalDependencies[packageName] = version;

  const sourceBinary = join(
    artifactRoot,
    `binary-${platform.id}`,
    platform.binary,
  );
  requireFile(sourceBinary, `${platform.id} build artifact`);

  const packageDir = join(outputRoot, platform.id);
  const targetBinary = join(packageDir, "bin", platform.binary);
  mkdirSync(dirname(targetBinary), { recursive: true });
  copyFileSync(sourceBinary, targetBinary);
  if (platform.os !== "win32") {
    chmodSync(targetBinary, 0o755);
  }

  writeJson(join(packageDir, "package.json"), {
    name: packageName,
    version,
    description: `${platform.id} binary for ${rootPackageName}`,
    license: "Apache-2.0",
    files: ["bin", "README.md", "LICENSE", "NOTICE"],
    engines: { node: ">=18" },
    os: [platform.os],
    cpu: [platform.cpu],
    repository,
    publishConfig: { access: "public" },
  });
  copyLegalFiles(packageDir);
  writeFileSync(
    join(packageDir, "README.md"),
    `# ${packageName}\n\nNative ${platform.id} binary package for \`${rootPackageName}\`. It is installed automatically as an optional dependency; install the root package instead of this package directly.\n`,
  );
}

const rootDir = join(outputRoot, "root");
mkdirSync(join(rootDir, "bin"), { recursive: true });
const launcherSource = join(repoRoot, "build", "npm-ipass", "bin", "dws.js");
requireFile(launcherSource, "DWS npm launcher");
copyFileSync(launcherSource, join(rootDir, "bin", "dws.js"));
chmodSync(join(rootDir, "bin", "dws.js"), 0o755);

writeJson(join(rootDir, "package.json"), {
  name: rootPackageName,
  version,
  description: "DingTalk Workspace CLI build for the Yingdao iPaaS BASE_URL adapter",
  keywords: ["dingtalk", "dws", "cli", "ipass", "base-url"],
  homepage: "https://github.com/wn0x00/dingtalk-workspace-cli#readme",
  bugs: { url: "https://github.com/wn0x00/dingtalk-workspace-cli/issues" },
  repository,
  license: "Apache-2.0",
  type: "module",
  bin: { dws: "bin/dws.js" },
  files: ["bin", "README.md", "LICENSE", "NOTICE"],
  optionalDependencies,
  publishConfig: { access: "public" },
  engines: { node: ">=18" },
});
copyLegalFiles(rootDir);

const upstreamReadme = readFileSync(join(repoRoot, "README.md"), "utf8");
const releaseNotice = `# ${rootPackageName}\n\n> Unofficial npm distribution built from [wn0x00/dingtalk-workspace-cli](https://github.com/wn0x00/dingtalk-workspace-cli). It keeps DWS commands while routing supported DingTalk MCP requests through the BASE_URL adapter configured by \`DINGTALK_CLI_BASE_URL\`.\n\nInstall:\n\n\`\`\`bash\nnpm install -g ${rootPackageName}\n\`\`\`\n\nConfigure:\n\n\`\`\`bash\nexport DINGTALK_CLI_BASE_URL=https://your-adapter.example.com\ndws --help\n\`\`\`\n\nThe adapter owns user authorization. Do not put DingTalk OAuth tokens or \`authId\` values in this package or environment variable. Agent Skills are embedded in the native binary; run \`dws skill setup\` when they need to be installed or refreshed.\n\n---\n\n`;
writeFileSync(join(rootDir, "README.md"), releaseNotice + upstreamReadme);

console.log(`Prepared ${rootPackageName}@${version}`);
console.log(`Output: ${outputRoot}`);
