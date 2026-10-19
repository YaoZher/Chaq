const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { main } = require("./install-dependencies");
const { npmCommand, runProjectNpm } = require("./project-npm");

function fixture(context) {
  const fixtureRoot = path.resolve(__dirname, "..", ".chaq-data", "test-tmp");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureRoot, "install-npm-"));
  context.after(() => {
    assert.equal(path.dirname(root), fixtureRoot);
    fs.rmSync(root, { recursive: true, force: true });
  });
  // A synthetic version keeps these cases independent of the CI machine's npm.
  const version = "99.18.0";
  const paths = { projectRoot: root, npmCache: path.join(root, "cache"), electronCache: path.join(root, "electron") };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ packageManager: `npm@${version}` }));
  function cli(directory, installedVersion = version) {
    const npmDirectory = path.join(directory, "node_modules", "npm");
    fs.mkdirSync(path.join(npmDirectory, "bin"), { recursive: true });
    fs.writeFileSync(path.join(npmDirectory, "package.json"), JSON.stringify({ name: "npm", version: installedVersion }));
    const filename = path.join(npmDirectory, "bin", "npm-cli.js");
    fs.writeFileSync(filename, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    return filename;
  }
  return { root, version, paths, cli, executable: path.join(root, "node.exe") };
}

test("setup selects the pinned CLI even when npm_execpath points at an older npm", (context) => {
  const current = fixture(context);
  const oldCli = current.cli(path.join(current.root, "old"), "11.11.0");
  const pinnedDirectory = path.join(current.root, "pinned npm");
  const pinnedCli = current.cli(pinnedDirectory);
  const command = npmCommand({
    ...current,
    environment: { npm_execpath: oldCli, Path: pinnedDirectory }
  });
  assert.equal(command.cli, pinnedCli);
  assert.equal(command.bootstrap, false);
  assert.deepEqual(command.prefix, []);
});

test("setup reuses an exact cached npm without requiring another npm or network bootstrap", (context) => {
  const current = fixture(context);
  current.cli(path.join(current.paths.npmCache, "_npx", "older"), "11.11.0");
  const cachedCli = current.cli(path.join(current.paths.npmCache, "_npx", "matching"));
  const command = npmCommand({ ...current, environment: { npm_config_cache: current.paths.npmCache } });
  assert.equal(command.cli, cachedCli);
  assert.equal(command.bootstrap, false);
});

test("a missing pinned CLI bootstraps that exact version through npm exec", (context) => {
  const current = fixture(context);
  const oldCli = current.cli(path.join(current.root, "old"), "11.11.0");
  const command = npmCommand({ ...current, environment: { npm_execpath: oldCli } });
  assert.equal(command.cli, oldCli);
  assert.equal(command.bootstrap, true);
  assert.deepEqual(command.prefix, ["exec", "--yes", "--prefer-offline", `--package=npm@${current.version}`, "--", "npm"]);
});

test("invalid package manager pins and unavailable bootstrap CLIs fail before installation", (context) => {
  const current = fixture(context);
  assert.throws(() => npmCommand({ ...current, environment: {} }), /Could not locate npm-cli.js/);
  for (const packageManager of [undefined, "pnpm@10.0.0", "npm@latest", "npm@11.18.0 & echo injected"]) {
    fs.writeFileSync(path.join(current.root, "package.json"), JSON.stringify({ packageManager }));
    assert.throws(() => npmCommand({ ...current, environment: {} }), /must pin an exact npm version/);
  }
});

test("the selected CLI executes through Node with paths and arguments preserved literally", (context) => {
  const current = fixture(context);
  const cli = current.cli(path.join(current.root, "npm tools & symbols"));
  const args = ["value with spaces", "%PATH%", "$(echo unsafe)", "a&b"];
  const result = runProjectNpm(args, {
    root: current.root,
    environment: { ...process.env, npm_execpath: cli },
    log: () => {},
    spawn: (command, commandArgs, options) => {
      assert.equal(command, process.execPath);
      assert.equal(options.windowsHide, true);
      assert.equal(options.shell, undefined);
      return spawnSync(command, commandArgs, { ...options, stdio: "pipe", encoding: "utf8" });
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

function installHarness(context, results = [{ status: 0 }, { status: 0 }]) {
  const current = fixture(context);
  const cli = current.cli(path.join(current.root, "npm"));
  const calls = [];
  const options = {
    paths: current.paths,
    environment: { npm_execpath: cli, ELECTRON_MIRROR: "https://mirror.example.test/electron/" },
    log: () => {},
    spawn: (command, args, settings) => {
      calls.push({ command, args, settings });
      return results[calls.length - 1];
    },
    recordState: (root) => {
      calls.push({ recorded: root });
      return { stateFile: path.join(root, "state.json") };
    }
  };
  return { ...current, cli, calls, options };
}

test("full setup records state only after npm and the Electron runtime both succeed", (context) => {
  const current = installHarness(context);
  assert.equal(main([], current.options), 0);
  assert.equal(current.calls.length, 3);
  assert.deepEqual(current.calls[0].args, [current.cli, "install"]);
  assert.equal(current.calls[0].settings.cwd, current.root);
  assert.equal(current.calls[0].settings.env.npm_config_cache, current.paths.npmCache);
  assert.equal(current.calls[0].settings.env.electron_config_cache, current.paths.electronCache);
  assert.equal(current.calls[0].settings.env.ELECTRON_MIRROR, current.options.environment.ELECTRON_MIRROR);
  assert.match(current.calls[1].args[0], /ensure-electron-runtime\.js$/);
  assert.equal(current.calls[1].settings.windowsHide, true);
  assert.deepEqual(current.calls[2], { recorded: current.root });
});

test("server-only clean setup retains workspace flags and never records full-client state", (context) => {
  const current = installHarness(context);
  assert.equal(main(["--server-only", "--ci"], current.options), 0);
  assert.equal(current.calls.length, 1);
  assert.deepEqual(current.calls[0].args, [
    current.cli, "ci", "--workspace", "@chaq/server", "--workspace", "@chaq/shared", "--include-workspace-root"
  ]);
});

test("failed or terminated npm installs do not restore Electron or record installed state", (context) => {
  for (const result of [{ status: 42 }, { status: null, signal: "SIGTERM" }]) {
    const current = installHarness(context, [result]);
    assert.equal(main([], current.options), result.status ?? 1);
    assert.equal(current.calls.length, 1);
  }
  const error = new Error("npm could not start");
  const current = installHarness(context, [{ status: null, error }]);
  assert.throws(() => main([], current.options), (actual) => actual === error);
  assert.equal(current.calls.length, 1);
});

test("Electron restoration failures never record installed state", (context) => {
  for (const result of [{ status: 7 }, { status: null, signal: "SIGTERM" }]) {
    const current = installHarness(context, [{ status: 0 }, result]);
    assert.equal(main([], current.options), result.status ?? 1);
    assert.equal(current.calls.length, 2);
  }
  const error = new Error("Electron restoration could not start");
  const current = installHarness(context, [{ status: 0 }, { status: null, error }]);
  assert.throws(() => main([], current.options), (actual) => actual === error);
  assert.equal(current.calls.length, 2);
});
