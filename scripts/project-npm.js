const { existsSync, readFileSync, readdirSync, realpathSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function npmCli(candidate) {
  if (!candidate) return null;
  try {
    const cli = realpathSync(candidate);
    if (path.basename(cli) !== "npm-cli.js") return null;
    const manifest = JSON.parse(readFileSync(path.join(path.dirname(cli), "..", "package.json"), "utf8"));
    return manifest.name === "npm" && typeof manifest.version === "string"
      ? { cli, version: manifest.version }
      : null;
  } catch {
    return null;
  }
}

function npmCommand({ root, environment = process.env, executable = process.execPath }) {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const version = /^npm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager)?.[1];
  if (!version) {
    throw new Error("package.json must pin an exact npm version in packageManager (for example npm@11.18.0).");
  }

  const pathValue = Object.entries(environment).find(([key]) => key.toLowerCase() === "path")?.[1] || "";
  const directories = [path.dirname(executable), ...pathValue.split(path.delimiter).filter(Boolean)];
  const candidates = [environment.npm_execpath];
  for (const directory of directories) {
    candidates.push(
      path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(directory, "npm")
    );
  }
  const installed = [...new Set(candidates)].map(npmCli).filter(Boolean);
  let selected = installed.find((candidate) => candidate.version === version);

  // Reuse npm exec's project cache without relying on its internal directory hash.
  const cache = environment.npm_config_cache && path.join(environment.npm_config_cache, "_npx");
  if (!selected && cache && existsSync(cache)) {
    for (const entry of readdirSync(cache, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cached = npmCli(path.join(cache, entry.name, "node_modules", "npm", "bin", "npm-cli.js"));
      if (cached?.version === version) {
        selected = cached;
        break;
      }
    }
  }
  if (selected) return { cli: selected.cli, prefix: [], version, bootstrap: false };

  if (!installed.length) {
    throw new Error("Could not locate npm-cli.js. Run setup through npm or install npm beside Node.js.");
  }
  return {
    cli: installed[0].cli,
    prefix: ["exec", "--yes", "--prefer-offline", `--package=npm@${version}`, "--", "npm"],
    version,
    bootstrap: true
  };
}

function runProjectNpm(args, options) {
  const { root, environment = process.env, spawn = spawnSync, executable = process.execPath, log = console.log } = options;
  const command = npmCommand({ root, environment, executable });
  log(`[dependencies] Using npm ${command.version}${command.bootstrap ? " through the project npm cache" : ""}.`);
  return spawn(executable, [command.cli, ...command.prefix, ...args], {
    cwd: root,
    env: environment,
    stdio: "inherit",
    windowsHide: true
  });
}

module.exports = { npmCommand, runProjectNpm };
