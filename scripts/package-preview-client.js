const fs = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { projectRoot } = require("./env-paths");
const { stopPreviewClient } = require("./stop-preview-client");

const previewApiUrl = "http://127.0.0.1:24538/api";
const previewCacheRoot = path.join(projectRoot, ".chaq-data");
const electronCache = path.join(previewCacheRoot, "electron-cache");
const npmCache = path.join(previewCacheRoot, "npm-cache");
const previewTemp = path.join(previewCacheRoot, "tmp");
const desktopDirectory = path.join(projectRoot, "apps", "desktop");
const executablePath = path.join(desktopDirectory, "release-preview", "win-unpacked", "Chaq.exe");
const archivePath = path.join(desktopDirectory, "release-preview", "win-unpacked", "resources", "app.asar");
const manifestPath = path.join(projectRoot, ".chaq-data", "preview-client-build.json");
const legacyPreviewDataPath = path.join(desktopDirectory, "release-preview", "win-unpacked", ".chaq-data");
const durablePreviewDataPath = path.join(projectRoot, ".chaq-data", "desktop-preview", "Chaq");
const sourceDirectories = [
  path.join(desktopDirectory, "src"),
  path.join(projectRoot, "packages", "shared", "src")
];
const sourceFiles = [
  path.join(desktopDirectory, "package.json"),
  path.join(desktopDirectory, "electron.vite.config.ts"),
  path.join(desktopDirectory, "tsconfig.json"),
  path.join(desktopDirectory, "index.html"),
  path.join(desktopDirectory, ".env"),
  path.join(desktopDirectory, ".env.local"),
  path.join(desktopDirectory, ".env.production"),
  path.join(desktopDirectory, ".env.production.local"),
  path.join(projectRoot, "packages", "shared", "package.json"),
  path.join(projectRoot, "packages", "shared", "tsconfig.json"),
  path.join(projectRoot, "package-lock.json"),
  path.join(projectRoot, "scripts", "ensure-electron-runtime.js"),
  path.join(projectRoot, "scripts", "package-preview-client.js"),
  path.join(projectRoot, "scripts", "run-electron-builder.js"),
  path.join(projectRoot, "scripts", "stop-preview-client.js"),
  path.join(projectRoot, "tools", "start-preview.bat"),
  path.join(projectRoot, "tools", "start-preview.ps1"),
  path.join(projectRoot, "tools", "start-preview-runtime.bat")
].concat(
  fs.readdirSync(projectRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^tsconfig.*\.json$/i.test(entry.name))
    .map((entry) => path.join(projectRoot, entry.name))
);

function normalizeMigrationRelativePath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    return null;
  }
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("\0")) return null;
  return normalized;
}

function selectNonOverwritingMigrationFiles(sourceFiles, destinationFiles, caseInsensitive = true) {
  const key = (value) => caseInsensitive ? value.toLowerCase() : value;
  const occupied = new Set(
    destinationFiles
      .map(normalizeMigrationRelativePath)
      .filter(Boolean)
      .map(key)
  );
  const selected = [];
  const seen = new Set();
  for (const sourceFile of sourceFiles) {
    const normalized = normalizeMigrationRelativePath(sourceFile);
    if (!normalized) continue;
    const normalizedKey = key(normalized);
    if (occupied.has(normalizedKey) || seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);
    selected.push(normalized);
  }
  return selected;
}

function listRegularFiles(root, relativeDirectory = "") {
  const absoluteDirectory = path.join(root, relativeDirectory);
  if (!fs.existsSync(absoluteDirectory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
    const absolute = path.join(root, relative);
    const metadata = fs.lstatSync(absolute);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Refusing to migrate preview data through a symbolic link: ${absolute}`);
    }
    if (metadata.isDirectory()) files.push(...listRegularFiles(root, relative));
    else if (metadata.isFile()) files.push(relative);
    else throw new Error(`Unsupported entry in preview data directory: ${absolute}`);
  }
  return files;
}

function ensureSafeProjectDirectory(directory, allowCollision = false) {
  const relative = path.relative(projectRoot, path.resolve(directory));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Preview data destination must be a project-relative child directory: ${directory}`);
  }
  let current = projectRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      fs.mkdirSync(current);
      continue;
    }
    const metadata = fs.lstatSync(current);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) continue;
    if (allowCollision) return false;
    throw new Error(`Unsafe preview data destination component: ${current}`);
  }
  return true;
}

function migrateLegacyPreviewData(
  sourceRoot = legacyPreviewDataPath,
  destinationRoot = durablePreviewDataPath
) {
  if (!fs.existsSync(sourceRoot)) return { copied: 0, skipped: 0, total: 0 };
  ensureSafeProjectDirectory(destinationRoot);
  const sourceFiles = listRegularFiles(sourceRoot);
  const destinationFiles = listRegularFiles(destinationRoot);
  const selected = selectNonOverwritingMigrationFiles(sourceFiles, destinationFiles, process.platform === "win32");
  let copied = 0;
  let skipped = sourceFiles.length - selected.length;

  for (const relative of selected) {
    const source = path.join(sourceRoot, relative);
    const destination = path.join(destinationRoot, relative);
    if (!ensureSafeProjectDirectory(path.dirname(destination), true) || fs.existsSync(destination)) {
      skipped += 1;
      continue;
    }
    try {
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      copied += 1;
    } catch (error) {
      if (error?.code === "EEXIST") {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return { copied, skipped, total: sourceFiles.length };
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en"))
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(absolute) : entry.isFile() ? [absolute] : [];
    });
}

function previewBuildFingerprint() {
  const hash = createHash("sha256");
  hash.update(`preview-api=${previewApiUrl}\nforce-server=1\n`);
  const files = [...sourceDirectories.flatMap(listFiles), ...sourceFiles]
    .filter((file, index, list) => fs.existsSync(file) && list.indexOf(file) === index)
    .sort((left, right) => left.localeCompare(right, "en"));
  for (const file of files) {
    hash.update(path.relative(projectRoot, file).replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function packagedClientSnapshot() {
  if (!fs.existsSync(executablePath) || !fs.existsSync(archivePath)) return null;
  const executable = fs.statSync(executablePath);
  const archive = fs.statSync(archivePath);
  return {
    executableSize: executable.size,
    executableMtimeMs: Math.trunc(executable.mtimeMs),
    archiveSize: archive.size,
    archiveSha256: createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex")
  };
}

function manifestMatches(manifest, fingerprint, snapshot) {
  return Boolean(
    manifest
    && snapshot
    && manifest.version === 2
    && manifest.apiUrl === previewApiUrl
    && manifest.forceConfiguredServer === true
    && manifest.fingerprint === fingerprint
    && manifest.executableSize === snapshot.executableSize
    && manifest.executableMtimeMs === snapshot.executableMtimeMs
    && manifest.archiveSize === snapshot.archiveSize
    && manifest.archiveSha256 === snapshot.archiveSha256
  );
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function previewClientIsCurrent() {
  return manifestMatches(readManifest(), previewBuildFingerprint(), packagedClientSnapshot());
}

function previewBuildEnvironment(baseEnvironment = process.env) {
  const controlledVariables = new Set([
    "CHAQ_ENV_ROOT",
    "ELECTRON_BUILDER_CACHE",
    "ELECTRON_CACHE",
    "ELECTRON_CONFIG_CACHE",
    "NODE_ENV",
    "NPM_CONFIG_CACHE"
  ]);
  const environment = Object.fromEntries(
    Object.entries(baseEnvironment).filter(([name]) => {
      const normalized = name.toUpperCase();
      return !normalized.startsWith("VITE_") && !controlledVariables.has(normalized);
    })
  );
  return {
    ...environment,
    NODE_ENV: "production",
    CHAQ_ENV_ROOT: "",
    ELECTRON_BUILDER_CACHE: "",
    ELECTRON_CACHE: electronCache,
    electron_config_cache: electronCache,
    npm_config_cache: npmCache,
    TEMP: previewTemp,
    TMP: previewTemp,
    VITE_SERVER_URL: previewApiUrl,
    VITE_PUBLIC_SERVER_URL: previewApiUrl,
    VITE_ALLOW_LOCAL_API_FALLBACK: "1",
    VITE_FORCE_SERVER_URL: "1"
  };
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd || projectRoot,
    env: options.env || process.env,
    stdio: "inherit",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(file)} ${args.join(" ")} failed with exit code ${result.status}.`);
}

function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
  ].filter(Boolean);
  const npmCli = candidates.find((candidate) => fs.existsSync(candidate));
  if (!npmCli) {
    throw new Error("Could not locate npm-cli.js. Run this command through npm or install npm beside Node.js.");
  }
  return npmCli;
}

function writeManifest(expectedFingerprint) {
  const completedFingerprint = previewBuildFingerprint();
  if (completedFingerprint !== expectedFingerprint) {
    throw new Error("Preview client sources changed while packaging. The build manifest was not written; retry the build.");
  }
  const snapshot = packagedClientSnapshot();
  if (!snapshot) throw new Error(`Preview executable was not produced at ${executablePath}.`);
  const manifest = {
    version: 2,
    apiUrl: previewApiUrl,
    forceConfiguredServer: true,
    fingerprint: expectedFingerprint,
    ...snapshot,
    builtAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const temporary = `${manifestPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\r\n`, "utf8");
  fs.renameSync(temporary, manifestPath);
}

function buildPreviewClient() {
  const stopped = stopPreviewClient({ executablePath });
  if (stopped.gracefullyRequested) {
    console.log(`[Chaq] Closed ${stopped.gracefullyRequested} running preview client process(es) before rebuilding.`);
  }
  const expectedFingerprint = previewBuildFingerprint();
  fs.rmSync(manifestPath, { force: true });
  fs.mkdirSync(previewTemp, { recursive: true });
  const env = previewBuildEnvironment();
  run(process.execPath, [path.join(projectRoot, "scripts", "ensure-electron-runtime.js")], { env });
  run(process.execPath, [resolveNpmCli(), "run", "build", "-w", "@chaq/desktop"], { env });
  const migration = migrateLegacyPreviewData();
  if (migration.total) {
    console.log(`[Chaq] Preserved legacy preview data in ${durablePreviewDataPath} (${migration.copied} copied, ${migration.skipped} already present).`);
  }
  run(process.execPath, [
    path.join(projectRoot, "scripts", "run-electron-builder.js"),
    "--dir",
    "-c.win.signAndEditExecutable=false",
    "-c.directories.output=release-preview"
  ], { cwd: desktopDirectory, env });
  writeManifest(expectedFingerprint);
  console.log(`[Chaq] Preview client package is current: ${executablePath}`);
}

if (require.main === module) {
  try {
    if (process.argv.includes("--check")) {
      if (previewClientIsCurrent()) {
        console.log("[Chaq] Preview client build manifest is current.");
        process.exit(0);
      }
      console.log("[Chaq] Preview client requires a rebuild.");
      process.exit(1);
    }
    buildPreviewClient();
  } catch (error) {
    console.error(`[ERROR] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = {
  manifestMatches,
  migrateLegacyPreviewData,
  normalizeMigrationRelativePath,
  previewBuildEnvironment,
  previewBuildFingerprint,
  previewClientIsCurrent,
  selectNonOverwritingMigrationFiles
};
