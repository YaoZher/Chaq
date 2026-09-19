const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const windowsHosts = ["npipe:////./pipe/dockerDesktopLinuxEngine", "npipe:////./pipe/docker_engine"];

function localDockerHosts(environment = process.env, platform = process.platform) {
  const configured = String(environment.DOCKER_HOST || "").trim();
  const context = String(environment.DOCKER_CONTEXT || "").trim();
  if (context && !["default", "desktop-linux"].includes(context)) {
    throw new Error("Local startup cannot use a custom DOCKER_CONTEXT. Clear DOCKER_CONTEXT for this launch; remote Docker engines are not supported.");
  }
  if (configured) {
    const local = platform === "win32"
      ? /^npipe:\/\/\/\/\.\/pipe\/[^/\\]+$/i.test(configured)
      : /^unix:\/\/\/[^\0]+$/.test(configured);
    if (!local) throw new Error("Local startup requires a local Docker pipe or Unix socket. Clear the remote DOCKER_HOST for this launch.");
    return [configured];
  }
  if (platform === "win32") return [...windowsHosts];
  return [...new Set([
    environment.XDG_RUNTIME_DIR && `unix://${path.posix.join(environment.XDG_RUNTIME_DIR, "docker.sock")}`,
    environment.HOME && `unix://${path.posix.join(environment.HOME, ".docker", "run", "docker.sock")}`,
    "unix:///var/run/docker.sock"
  ].filter(Boolean))];
}

function dockerEnvironmentForHost(environment, host) {
  return {
    ...environment,
    DOCKER_HOST: host,
    // Empty values also override callers that merge this back into process.env.
    DOCKER_CONTEXT: "",
    DOCKER_TLS: "",
    DOCKER_TLS_VERIFY: "",
    DOCKER_CERT_PATH: ""
  };
}

function probeDockerEngine({ environment, host, timeoutMs = 4000, spawn = spawnSync }) {
  const result = spawn("docker", ["--host", host, "info", "--format", "{{.OSType}}"], {
    env: dockerEnvironmentForHost(environment, host),
    encoding: "utf8",
    stdio: "pipe",
    timeout: Math.max(1, timeoutMs),
    windowsHide: true
  });
  if (result.error?.code === "ENOENT") return { ready: false, missingCli: true };
  const output = String(result.stdout || "").trim();
  return {
    ready: result.status === 0 && output === "linux",
    windowsContainers: result.status === 0 && output === "windows",
    detail: String(result.error?.message || result.stderr || "").trim().slice(0, 1200)
  };
}

function findDockerDesktop({ environment = process.env, exists = fs.existsSync, realpath = fs.realpathSync, spawn = spawnSync } = {}) {
  const candidates = [];
  const directories = String(environment.Path || environment.PATH || "").split(";")
    .map((entry) => entry.trim().replace(/^"|"$/g, "")).filter(Boolean);
  for (const directory of directories) {
    const cli = path.win32.join(directory, "docker.exe");
    if (!exists(cli)) continue;
    let resolved = cli;
    try { resolved = realpath(cli); } catch { /* The original PATH entry may still locate the installation. */ }
    for (const binary of [resolved, cli]) {
      const bin = path.win32.dirname(binary);
      candidates.push(path.win32.join(bin, "..", "..", "Docker Desktop.exe"));
    }
  }
  const fromPath = candidates.find((candidate) => exists(candidate));
  if (fromPath) return fromPath;

  const registryKeys = [
    ["HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Docker Desktop", "InstallLocation"],
    ["HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Docker Desktop", "InstallLocation"],
    ["HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Docker Desktop", "InstallLocation"],
    ["HKLM\\SOFTWARE\\Docker Inc.\\Docker Desktop", "InstallPath"]
  ];
  for (const [key, value] of registryKeys) {
    const result = spawn("reg.exe", ["query", key, "/v", value], {
      env: environment, encoding: "utf8", stdio: "pipe", windowsHide: true, timeout: 2000
    });
    const match = result.status === 0 && String(result.stdout).match(/REG_(?:EXPAND_)?SZ\s+(.+)\s*$/m);
    if (!match) continue;
    const installPath = match[1].trim().replace(/%([^%]+)%/g, (original, name) => {
      const entry = Object.keys(environment).find((item) => item.toLowerCase() === name.toLowerCase());
      return entry ? environment[entry] : original;
    });
    candidates.push(path.win32.join(installPath, "Docker Desktop.exe"));
  }
  candidates.push(path.win32.join(environment.ProgramFiles || "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe"));
  if (environment.LOCALAPPDATA) candidates.push(path.win32.join(environment.LOCALAPPDATA, "Docker", "Docker Desktop.exe"));
  return candidates.find((candidate) => exists(candidate)) || null;
}

function startDockerDesktop({ executablePath, environment, spawn = spawnSync }) {
  const result = spawn("docker", ["desktop", "start", "--detach", "--timeout", "10"], {
    env: environment, encoding: "utf8", stdio: "pipe", timeout: 15000, windowsHide: true
  });
  if (!result.error && result.status === 0) return;
  const detail = String(result.error?.message || result.stderr || result.stdout || "").trim().slice(0, 1200);
  const unsupported = /not a docker command|unknown command|unknown flag|unknown shorthand flag|plugin.*not found|not recognized/i.test(detail);
  if (!unsupported) {
    throw new Error(`Docker Desktop could not start. Open Docker Desktop to resolve its WSL, virtualization, or permission error, then retry.${detail ? ` Details: ${detail}` : ""}`);
  }
  // Pass the installed path as data; spaces and shell metacharacters never enter the command text.
  const fallback = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:CHAQ_DOCKER_DESKTOP_EXE -WindowStyle Hidden -ErrorAction Stop"
  ], {
    env: { ...environment, CHAQ_DOCKER_DESKTOP_EXE: executablePath },
    encoding: "utf8", stdio: "pipe", timeout: 10000, windowsHide: true
  });
  if (fallback.error || fallback.status !== 0) {
    throw new Error(`Docker Desktop could not be launched. Open ${executablePath} manually and resolve any permission or first-run prompt, then retry.`);
  }
}

async function ensureDockerEngine(options = {}) {
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  const hosts = localDockerHosts(environment, platform);
  const probe = options.probe || probeDockerEngine;
  const findDesktop = options.findDesktop || findDockerDesktop;
  const startDesktop = options.startDesktop || startDockerDesktop;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now || Date.now;
  const log = options.log || console.log;
  const timeoutMs = options.timeoutMs ?? 120000;
  const deadline = now() + timeoutMs;
  let lastDetail = "";

  async function check() {
    let windowsContainers = false;
    for (const host of hosts) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      const result = await probe({ environment, host, timeoutMs: Math.min(4000, remaining) });
      if (result.missingCli) throw new Error("Docker CLI was not found. Install Docker Desktop, complete its first launch, and add its resources\\bin folder to PATH before retrying.");
      if (result.ready) return dockerEnvironmentForHost(environment, host);
      windowsContainers ||= result.windowsContainers;
      if (result.detail) lastDetail = result.detail;
    }
    if (windowsContainers) throw new Error("Docker is running Windows containers. Switch Docker Desktop to Linux containers, then retry Chaq startup.");
    return null;
  }

  const ready = await check();
  if (ready) return { started: false, dockerEnvironment: ready };
  if (platform !== "win32") {
    throw new Error(`The local Docker engine is not ready. Start Docker Engine or Docker Desktop, then retry.${lastDetail ? ` Details: ${lastDetail}` : ""}`);
  }
  const executablePath = await findDesktop({ environment });
  if (!executablePath) {
    throw new Error("Docker Desktop was not found. Install Docker Desktop or add its installed resources\\bin folder to PATH, complete first-time setup, then retry.");
  }
  log("[INFO] Starting Docker Desktop and waiting for the local Linux engine...");
  await startDesktop({ executablePath, environment: dockerEnvironmentForHost(environment, hosts[0]) });
  let nextProgress = now() + 10000;
  while (now() < deadline) {
    const active = await check();
    if (active) {
      log("[OK] Local Docker Linux engine is ready.");
      return { started: true, dockerEnvironment: active };
    }
    if (now() >= nextProgress) {
      log("[INFO] Docker Desktop is still starting; waiting for its Linux engine...");
      nextProgress = now() + 10000;
    }
    await sleep(Math.min(2000, Math.max(0, deadline - now())));
  }
  throw new Error(`Docker Desktop did not make its Linux engine ready within ${Math.ceil(timeoutMs / 1000)} seconds. Open Docker Desktop and resolve any first-run, WSL, virtualization, or permission error, then retry.${lastDetail ? ` Details: ${lastDetail}` : ""}`);
}

module.exports = {
  dockerEnvironmentForHost,
  ensureDockerEngine,
  findDockerDesktop,
  localDockerHosts,
  probeDockerEngine,
  startDockerDesktop
};
