const { mkdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const environmentPaths = require("./env-paths");
const { recordDependencyState } = require("./dependency-state");
const { runProjectNpm } = require("./project-npm");

function main(argv = process.argv.slice(2), {
  paths = environmentPaths,
  environment = process.env,
  spawn = spawnSync,
  recordState = recordDependencyState,
  log = console.log
} = {}) {
  const { electronCache, npmCache, projectRoot } = paths;
  const serverOnly = argv.includes("--server-only");
  const cleanInstall = argv.includes("--ci");
  const args = [cleanInstall ? "ci" : "install"];

  if (serverOnly) {
    args.push(
      "--workspace", "@chaq/server",
      "--workspace", "@chaq/shared",
      "--include-workspace-root"
    );
  }

  mkdirSync(electronCache, { recursive: true });
  mkdirSync(npmCache, { recursive: true });

  const installEnvironment = {
    ...environment,
    npm_config_cache: npmCache,
    electron_config_cache: electronCache,
    ELECTRON_MIRROR: environment.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/"
  };
  const result = runProjectNpm(args, {
    root: projectRoot,
    environment: installEnvironment,
    spawn,
    log
  });

  if (result.error) throw result.error;
  if (result.status !== 0) return result.status ?? 1;

  if (!serverOnly) {
    const electronResult = spawn(process.execPath, [
      require.resolve("./ensure-electron-runtime")
    ], {
      cwd: projectRoot,
      env: environment,
      stdio: "inherit",
      windowsHide: true
    });

    if (electronResult.error) throw electronResult.error;
    if (electronResult.status !== 0) return electronResult.status ?? 1;

    const dependencyState = recordState(projectRoot);
    log(`[dependencies] Recorded installed dependency state: ${dependencyState.stateFile}`);
  }

  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main };
