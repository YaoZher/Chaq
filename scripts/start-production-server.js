const fs = require("node:fs");
const { createHash } = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { parseEnv } = require("./env-format");

const root = path.resolve(__dirname, "..");
const localPreview = process.argv.includes("--local-preview") || process.argv.includes("--preview");
if (localPreview) {
  // A preview is self-contained by definition. Machine-level path overrides
  // must never redirect generated configuration or service data elsewhere.
  delete process.env.CHAQ_ENV_ROOT;
  delete process.env.CHAQ_ENV_FILE;
  delete process.env.DOCKER_CONFIG;
  delete process.env.DOCKER_HOST;
  delete process.env.DOCKER_CONTEXT;
  delete process.env.DOCKER_TLS;
  delete process.env.DOCKER_TLS_VERIFY;
  delete process.env.DOCKER_CERT_PATH;
}

const { previewEnv, serverEnv, projectLogs } = require("./env-paths");
const {
  assessManagedProcess,
  getProcessIdentity,
  inspectLinuxProcess,
  inspectWindowsProcesses,
  isExpectedProjectProcess,
  parsePidRecord,
  productionEntry,
  stopManagedProcessRecord
} = require("./production-process-identity");

const publicBind = process.argv.includes("--public");
const skipBuild = process.argv.includes("--skip-build");
const statusOnly = process.argv.includes("--status");
const stopOnly = process.argv.includes("--stop");
const restart = process.argv.includes("--restart");
const foreground = process.argv.includes("--foreground");
const host = localPreview ? "127.0.0.1" : publicBind ? "0.0.0.0" : "127.0.0.1";
const port = localPreview ? 24538 : Number(process.env.CHAQ_PROD_SERVER_PORT || process.env.SERVER_PORT || 24538);
const runtimeProfile = localPreview ? "local-preview" : "standard";
const runtimeMarkerArgs = [
  `--chaq-runtime-profile=${runtimeProfile}`,
  `--chaq-runtime-port=${port}`
];
const runtimeMarkerPrefixes = ["--chaq-runtime-profile=", "--chaq-runtime-port="];
const defaultPublicApiUrl = "https://chaq.yaozher.com/api";
const defaultClientOrigin = "https://chaq.yaozher.com";
const pidDir = path.join(projectLogs, "pids");
const apiPidFile = path.join(pidDir, `api-${runtimeProfile}-${port}.pid`);
const workerPidFile = path.join(pidDir, `worker-${runtimeProfile}-${port}.pid`);
const apiLogName = localPreview ? "api-preview.log" : "api-prod.log";
const workerLogName = localPreview ? "worker-preview.log" : "worker-prod.log";
const productionEntries = {
  api: path.join(root, "apps", "server", "dist", "src", "main.js"),
  worker: path.join(root, "apps", "server", "dist", "src", "worker.js")
};
const prismaSchema = path.join(root, "apps", "server", "prisma", "schema.prisma");
const prismaStateFile = path.join(root, ".chaq-data", "prisma-client-state.json");

function command(name) {
  return process.platform === "win32" && !name.endsWith(".cmd") ? `${name}.cmd` : name;
}

function sanitizeEnv(source) {
  const env = {};
  const seen = new Set();
  for (const [key, value] of Object.entries(source)) {
    if (value == null) continue;
    const normalized = process.platform === "win32" ? key.toUpperCase() : key;
    if (process.platform === "win32" && normalized === "PATH") continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    env[key] = String(value);
  }
  if (process.platform === "win32") {
    env.Path = String(source.Path || source.PATH || process.env.Path || process.env.PATH || "");
  }
  return env;
}

function quoteCmdArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function normalizeApiUrl(value) {
  try {
    const url = new URL(String(value || defaultPublicApiUrl).trim());
    if (!url.pathname || url.pathname === "/") url.pathname = "/api";
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return defaultPublicApiUrl;
  }
}

function isLocalDevOrigin(value) {
  return /^https?:\/\/(localhost|127\.0\.0\.1):27337$/i.test(String(value || "").trim());
}

function resolveProductionClientOrigin(fileEnv) {
  const configured = process.env.CHAQ_PROD_CLIENT_ORIGIN
    || process.env.CLIENT_ORIGIN
    || fileEnv.CHAQ_PROD_CLIENT_ORIGIN
    || fileEnv.CLIENT_ORIGIN;
  return configured && !isLocalDevOrigin(configured) ? configured : defaultClientOrigin;
}

function resolvePublicApiUrl(fileEnv) {
  return normalizeApiUrl(
    process.env.CHAQ_PUBLIC_API_URL
    || process.env.PUBLIC_API_URL
    || fileEnv.CHAQ_PUBLIC_API_URL
    || fileEnv.PUBLIC_API_URL
    || defaultPublicApiUrl
  );
}

function run(file, args, env) {
  console.log(`[Chaq] ${file} ${args.join(" ")}`);
  const safeEnv = sanitizeEnv(env);
  const commandLine = [file, ...args].map(quoteCmdArg).join(" ");
  const useCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
  const result = useCmd
    ? spawnSync(safeEnv.ComSpec || process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], {
      cwd: root,
      env: safeEnv,
      stdio: "inherit",
      windowsHide: true
    })
    : spawnSync(file, args, {
    cwd: root,
    env: safeEnv,
    stdio: "inherit",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${file} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function prismaClientAvailable() {
  const clientIndex = path.join(root, "node_modules", ".prisma", "client", "index.js");
  const clientSchema = path.join(root, "node_modules", ".prisma", "client", "schema.prisma");
  if (!fs.existsSync(clientIndex) || !fs.existsSync(clientSchema) || !fs.existsSync(prismaSchema)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(prismaStateFile, "utf8"));
    const sourceHash = createHash("sha256").update(fs.readFileSync(prismaSchema)).digest("hex");
    return state?.version === 1
      && state.schemaSha256 === sourceHash
      && state.prismaVersion === installedPackageVersion("prisma")
      && state.prismaClientVersion === installedPackageVersion("@prisma/client");
  } catch {
    return false;
  }
}

function recordPrismaClientState() {
  const schemaSha256 = createHash("sha256").update(fs.readFileSync(prismaSchema)).digest("hex");
  fs.mkdirSync(path.dirname(prismaStateFile), { recursive: true });
  fs.writeFileSync(prismaStateFile, `${JSON.stringify({
    version: 1,
    schemaSha256,
    prismaVersion: installedPackageVersion("prisma"),
    prismaClientVersion: installedPackageVersion("@prisma/client"),
    generatedAt: new Date().toISOString()
  }, null, 2)}\r\n`, "utf8");
}

function installedPackageVersion(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "node_modules", ...name.split("/"), "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}

function ensurePrismaClient(env) {
  if (env.FORCE_PRISMA_GENERATE === "1" || !prismaClientAvailable()) {
    run(command("npm"), ["run", "prisma:generate"], env);
    recordPrismaClientState();
    return;
  }
  console.log("[Chaq] Prisma Client matches the current schema. Skipping generate to avoid Windows DLL locks.");
}

function ensureEnvironmentFile() {
  fs.mkdirSync(projectLogs, { recursive: true });
  if (localPreview) {
    const { writePreviewEnvironment } = require("./prepare-preview-env");
    const result = writePreviewEnvironment(previewEnv);
    console.log(`[Chaq] Using local preview env: ${result.filePath}`);
    return;
  }
  const envFile = process.env.CHAQ_ENV_FILE || serverEnv;
  if (fs.existsSync(envFile)) {
    console.log(`[Chaq] Using existing production env: ${envFile}`);
    return;
  }
  throw new Error(
    `Production environment file not found: ${envFile}. `
    + "Set CHAQ_ENV_FILE to a completed production environment file. "
    + "For a self-contained local preview, run tools\\start-client.bat."
  );
}

function ensurePreviewAccount(env) {
  if (!localPreview) return;
  run(process.execPath, ["scripts/create-admin-user.js"], {
    ...env,
    CHAQ_ADMIN_USERNAME: env.CHAQ_PREVIEW_USERNAME,
    CHAQ_ADMIN_PASSWORD: env.CHAQ_PREVIEW_PASSWORD,
    CHAQ_ADMIN_DISPLAY_NAME: env.CHAQ_PREVIEW_DISPLAY_NAME,
    CHAQ_ADMIN_TOKEN_BALANCE: env.CHAQ_PREVIEW_TOKEN_BALANCE
  });
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($process) { exit 0 }; exit 1`
    ], {
      stdio: "pipe",
      encoding: "utf8",
      windowsHide: true
    });
    return result.status === 0;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidRecord(file) {
  try {
    return parsePidRecord(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readPid(file) {
  return readPidRecord(file)?.pid ?? null;
}

function createPidRecord(pid, role, identity, projectRoot = root) {
  if (identity?.pid !== pid || !identity.startIdentity) {
    throw new Error(`Could not establish a safe process identity for ${role} pid=${pid}.`);
  }
  return {
    version: 1,
    pid,
    role,
    projectRoot,
    entry: productionEntry(projectRoot, role),
    runtimeProfile,
    port,
    executable: identity.executable || process.execPath,
    startIdentity: identity.startIdentity,
    recordedAt: new Date().toISOString()
  };
}

function writePid(file, pid, role) {
  const identity = getProcessIdentity(pid);
  const record = createPidRecord(pid, role, identity);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record)}\r\n`, "utf8");
}

function removePid(file) {
  fs.rmSync(file, { force: true });
}

function findListeningPid(targetPort) {
  if (process.platform !== "win32") return null;
  const result = spawnSync("netstat.exe", ["-ano", "-p", "tcp"], {
    stdio: "pipe",
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) return null;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.includes("LISTENING")) continue;
    const parts = line.trim().split(/\s+/);
    const local = parts[1] || "";
    const pid = Number(parts[parts.length - 1]);
    if (local.endsWith(`:${targetPort}`) && Number.isInteger(pid)) return pid;
  }
  return null;
}

function findProjectNodeProcesses(role) {
  const identities = process.platform === "win32"
    ? inspectWindowsProcesses(null)
    : process.platform === "linux"
      ? fs.readdirSync("/proc", { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .map((entry) => inspectLinuxProcess(Number(entry.name)))
        .filter(Boolean)
      : [];
  return identities.filter((identity) => isExpectedProjectProcess(identity, {
    projectRoot: root,
    role,
    executablePath: process.execPath,
    requiredArgs: runtimeMarkerArgs,
    exclusiveArgPrefixes: runtimeMarkerPrefixes
  }));
}

function findProjectNodePids(scriptName) {
  return findProjectNodeProcesses(scriptName === "worker.js" ? "worker" : "api").map((identity) => identity.pid);
}

function managedPidFileState(file, role, options = {}) {
  const record = readPidRecord(file);
  if (!record) return "missing";
  const identity = getProcessIdentity(record.pid);
  const assessment = assessManagedProcess(record, identity, {
    projectRoot: root,
    role,
    executablePath: process.execPath,
    runtimeProfile,
    port,
    requiredArgs: runtimeMarkerArgs,
    exclusiveArgPrefixes: runtimeMarkerPrefixes
  });
  if (assessment.safe) return "running";
  const inspectionUnknown = assessment.reason === "process command line is unavailable"
    || assessment.reason === "process does not exist or cannot be inspected";
  if (inspectionUnknown) {
    if (!identity && !processExists(record.pid)) {
      console.log(`[WARN] Ignoring stale ${role} pid file for pid=${record.pid}: the process no longer exists.`);
      if (options.mutate !== false) removePid(file);
      return "stale";
    }
    console.log(
      `[WARN] Could not verify ${role} pid=${record.pid}: ${assessment.reason}. `
      + "Preserving the pid record because process inspection may be temporarily unavailable."
    );
    return "unknown";
  }
  console.log(`[WARN] Ignoring stale ${role} pid file for pid=${record.pid}: ${assessment.reason}.`);
  if (options.mutate !== false) removePid(file);
  return "stale";
}

function productionWorkerRunning() {
  const state = managedPidFileState(workerPidFile, "worker");
  if (state === "unknown") {
    throw new Error(
      "The Agent worker pid exists but its process identity cannot be inspected. "
      + "Run the launcher with the same account and permissions as the existing preview, or stop that process manually."
    );
  }
  return state === "running" || findProjectNodePids("worker.js").length > 0;
}

function ensureProductionWorker(env) {
  if (productionWorkerRunning()) {
    console.log("[Chaq] Production Agent worker is already running.");
    return;
  }
  const workerEntry = productionEntries.worker;
  if (!fs.existsSync(workerEntry)) {
    run(command("npm"), ["run", "build", "-w", "@chaq/shared"], env);
    run(command("npm"), ["run", "build", "-w", "@chaq/server"], env);
  }
  const workerPid = startProcess(
    `Chaq ${localPreview ? "preview" : "production"} Agent worker`,
    [workerEntry, ...runtimeMarkerArgs],
    workerLogName,
    env
  );
  writePid(workerPidFile, workerPid, "worker");
}

function terminateVerifiedPid(pid, label) {
  if (!processExists(pid)) {
    console.log(`[Chaq] ${label} pid=${pid} is not running.`);
    return;
  }
  console.log(`[Chaq] Stopping ${label} pid=${pid}...`);
  const result = process.platform === "win32"
    ? spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "pipe", encoding: "utf8", windowsHide: true })
    : spawnSync("kill", [String(pid)], { stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0 && processExists(pid)) {
    throw new Error(`Could not stop ${label} pid=${pid}: ${(result.stderr || result.stdout || "").trim()}`);
  }
}

function stopManagedPidFile(file, role, label) {
  const result = stopManagedProcessRecord(readPidRecord(file), {
    projectRoot: root,
    role,
    label,
    executablePath: process.execPath,
    runtimeProfile,
    port,
    requiredArgs: runtimeMarkerArgs,
    exclusiveArgPrefixes: runtimeMarkerPrefixes
  }, {
    inspect: (pid) => getProcessIdentity(pid),
    exists: (pid) => processExists(pid),
    terminate: (pid, processLabel) => terminateVerifiedPid(pid, processLabel),
    clear: () => removePid(file),
    log: (message) => console.log(message)
  });
  if (result.preserved) {
    throw new Error(`Could not safely inspect ${label}; its pid record was preserved and no process was stopped.`);
  }
  return result;
}

function stopDiscoveredProcess(discoveredIdentity, role, label) {
  const currentIdentity = getProcessIdentity(discoveredIdentity.pid);
  const commandMatches = isExpectedProjectProcess(currentIdentity, {
    projectRoot: root,
    role,
    executablePath: process.execPath,
    requiredArgs: runtimeMarkerArgs,
    exclusiveArgPrefixes: runtimeMarkerPrefixes
  });
  const sameStart = Boolean(
    discoveredIdentity.startIdentity
    && currentIdentity?.startIdentity
    && discoveredIdentity.startIdentity === currentIdentity.startIdentity
  );
  if (!commandMatches || !sameStart) {
    console.log(`[WARN] Refusing to stop discovered pid=${discoveredIdentity.pid}: process identity changed or is unavailable.`);
    return false;
  }
  terminateVerifiedPid(discoveredIdentity.pid, label);
  return true;
}

function canConnect(hostname, targetPort) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: hostname, port: targetPort });
    socket.setTimeout(800);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

function readReady() {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/api/health/ready", timeout: 1500 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          const data = JSON.parse(body);
          resolve({
            ready: response.statusCode === 200 && data.status === "ok" && data.database === "ready" && data.redis === "ready",
            data
          });
        } catch {
          resolve({ ready: false, data: null });
        }
      });
    });
    request.once("timeout", () => {
      request.destroy();
      resolve({ ready: false, data: null });
    });
    request.once("error", () => resolve({ ready: false, data: null }));
  });
}

async function assertPortAvailableOrReady() {
  if (!(await canConnect("127.0.0.1", port))) return false;
  const status = await readReady();
  if (status.ready) {
    const mode = status.data && typeof status.data.mode === "string" ? status.data.mode : "unknown";
    const profile = status.data && typeof status.data.profile === "string" ? status.data.profile : "standard";
    if (mode !== "production" && mode !== "unknown") {
      throw new Error(`Port ${port} already has a Chaq API in ${mode} mode. Stop that process before starting production.`);
    }
    if (localPreview && profile !== "local-preview") {
      throw new Error(`Port ${port} already has a standard production API. Refusing to replace it with local preview.`);
    }
    if (!localPreview && profile === "local-preview") {
      throw new Error(`Port ${port} already has a local preview API. Stop it with tools\\stop-preview.bat first.`);
    }
    console.log(`[Chaq] API is already ready on http://127.0.0.1:${port}/api.`);
    if (mode === "unknown") {
      console.log("[Chaq] Existing API did not report runtime mode; startup was skipped to avoid a duplicate server.");
    }
    return true;
  }
  throw new Error(`Port ${port} is occupied, but it is not a ready Chaq API.`);
}

function startProcess(label, args, logName, env) {
  fs.mkdirSync(projectLogs, { recursive: true });
  const logPath = path.join(projectLogs, logName);
  fs.appendFileSync(logPath, `\r\n===== ${label} start ${new Date().toISOString()} =====\r\n`, "utf8");
  const out = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: sanitizeEnv(env),
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true
  });
  child.unref();
  fs.appendFileSync(logPath, `[Chaq] ${label} pid=${child.pid}\r\n`, "utf8");
  console.log(`[Chaq] Started ${label} pid=${child.pid}; log=${logPath}`);
  return child.pid;
}

function startForegroundProcess(label, args, logName, env, role) {
  fs.mkdirSync(projectLogs, { recursive: true });
  const logPath = path.join(projectLogs, logName);
  const log = fs.createWriteStream(logPath, { flags: "a" });
  log.write(`\r\n===== ${label} start ${new Date().toISOString()} =====\r\n`);
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: sanitizeEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  log.write(`[Chaq] ${label} pid=${child.pid}\r\n`);
  console.log(`[Chaq] Started ${label} pid=${child.pid}; log=${logPath}`);

  child.stdout.on("data", (chunk) => {
    log.write(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    log.write(chunk);
    process.stderr.write(chunk);
  });
  child.on("exit", (code, signal) => {
    log.write(`[Chaq] ${label} exited with code=${code ?? ""} signal=${signal ?? ""}\r\n`);
    log.end();
  });

  return { child, label, role };
}

function stopForegroundChildren(children) {
  for (const item of children) {
    if (!item.child.killed && item.child.exitCode == null) {
      const file = item.role === "api" ? apiPidFile : workerPidFile;
      stopManagedPidFile(file, item.role, item.label);
    }
  }
  removePid(apiPidFile);
  removePid(workerPidFile);
}

function keepForegroundAlive(children) {
  return new Promise((resolve, reject) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      console.log("[Chaq] Stopping production API server and Agent worker...");
      try {
        stopForegroundChildren(children);
        resolve();
      } catch (error) {
        reject(error);
      }
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.once("SIGHUP", shutdown);

    for (const item of children) {
      item.child.once("exit", (code, signal) => {
        if (stopping) return;
        stopping = true;
        try {
          stopForegroundChildren(children.filter((candidate) => candidate !== item));
        } catch {
          // The original process exit is the actionable failure.
        }
        reject(new Error(`${item.label} exited unexpectedly with code=${code ?? ""} signal=${signal ?? ""}. Check .logs for details.`));
      });
    }
  });
}

async function printStatus() {
  const status = await readReady();
  const reportedProfile = status.data?.profile || "standard";
  const readyForProfile = status.ready && reportedProfile === runtimeProfile;
  const apiPid = readPid(apiPidFile);
  const workerPid = readPid(workerPidFile);
  const listenerPid = findListeningPid(port);
  const scannedApiPids = findProjectNodePids("main.js");
  const scannedWorkerPids = findProjectNodePids("worker.js");
  const workerPidState = managedPidFileState(workerPidFile, "worker", { mutate: false });
  const workerReady = workerPidState === "running" || scannedWorkerPids.length > 0;
  const workerStatus = workerReady ? "yes" : workerPidState === "unknown" ? "unknown" : "no";
  console.log(`[Chaq] Production port: ${port}`);
  console.log(`[Chaq] API ready: ${readyForProfile ? "yes" : "no"}`);
  if (status.data) {
    console.log(`[Chaq] API mode: ${status.data.mode || "unknown"}; host: ${status.data.host || "unknown"}`);
    console.log(`[Chaq] Runtime profile: ${reportedProfile}`);
    console.log(`[Chaq] Database: ${status.data.database || "unknown"}; Redis: ${status.data.redis || "unknown"}`);
  }
  if (status.ready && !readyForProfile) {
    console.log(`[WARN] Port ${port} is ready for runtime profile ${reportedProfile}, not ${runtimeProfile}.`);
  }
  console.log(`[Chaq] API pid file: ${apiPid ?? "missing"}${apiPid ? ` (${processExists(apiPid) ? "running" : "stale"})` : ""}`);
  console.log(`[Chaq] Worker pid file: ${workerPid ?? "missing"}${workerPid ? ` (${processExists(workerPid) ? "running" : "stale"})` : ""}`);
  console.log(`[Chaq] Agent worker ready: ${workerStatus}`);
  console.log(`[Chaq] Listening pid on ${port}: ${listenerPid ?? "none"}`);
  if (scannedApiPids.length) console.log(`[Chaq] Project production API pids: ${scannedApiPids.join(", ")}`);
  if (scannedWorkerPids.length) console.log(`[Chaq] Project production worker pids: ${scannedWorkerPids.join(", ")}`);
  if (readyForProfile && (!apiPid || !workerPid) && !scannedWorkerPids.length) {
    console.log("[WARN] Production API is ready, but pid files are missing. This process was probably started by an older launcher.");
    console.log("[WARN] Close old production node processes once, then run tools\\start-server-prod.bat to adopt the managed startup scheme.");
  }
  console.log(`[Chaq] Logs: ${path.join(projectLogs, apiLogName)} ; ${path.join(projectLogs, workerLogName)}`);
  return readyForProfile && workerReady;
}

async function stopProduction() {
  const status = await readReady();
  const apiRecord = readPidRecord(apiPidFile);
  const workerRecord = readPidRecord(workerPidFile);
  const listenerPid = findListeningPid(port);
  const scannedApiProcesses = findProjectNodeProcesses("api");
  const scannedWorkerProcesses = findProjectNodeProcesses("worker");
  if (listenerPid && status.ready && status.data?.mode !== "production") {
    throw new Error(`Port ${port} is used by a ${status.data?.mode || "non-production"} Chaq API. Refusing to stop it as production.`);
  }
  if (listenerPid && status.ready) {
    const profile = status.data?.profile || "standard";
    if (localPreview && profile !== "local-preview") {
      throw new Error(`Port ${port} is used by a standard production API. Refusing to stop it as local preview.`);
    }
    if (!localPreview && profile === "local-preview") {
      throw new Error(`Port ${port} is used by local preview. Refusing to stop it as formal production.`);
    }
  }
  const seen = new Set();
  let candidates = 0;

  if (workerRecord) {
    candidates += 1;
    const result = stopManagedPidFile(workerPidFile, "worker", `${localPreview ? "preview" : "production"} Agent worker`);
    if (result.stopped) seen.add(workerRecord.pid);
  } else {
    removePid(workerPidFile);
  }
  if (apiRecord) {
    candidates += 1;
    const result = stopManagedPidFile(apiPidFile, "api", `${localPreview ? "preview" : "production"} API`);
    if (result.stopped) seen.add(apiRecord.pid);
  } else {
    removePid(apiPidFile);
  }

  const discovered = [
    ...scannedWorkerProcesses.map((identity) => ({ identity, role: "worker", label: `${localPreview ? "preview" : "production"} Agent worker` })),
    ...scannedApiProcesses.map((identity) => ({ identity, role: "api", label: `${localPreview ? "preview" : "production"} API` }))
  ];
  if (listenerPid && status.ready && !seen.has(listenerPid)) {
    const listenerIdentity = getProcessIdentity(listenerPid);
    if (listenerIdentity) discovered.push({ identity: listenerIdentity, role: "api", label: "production API listener" });
    else console.log(`[WARN] Refusing to stop listener pid=${listenerPid}: process command line is unavailable.`);
  }
  for (const item of discovered) {
    if (seen.has(item.identity.pid)) continue;
    seen.add(item.identity.pid);
    candidates += 1;
    stopDiscoveredProcess(item.identity, item.role, item.label);
  }

  if (!candidates) {
    console.log(`[Chaq] No production pid files found for port ${port}.`);
    if (!status.ready) return;
  }
  for (let index = 0; index < 20; index += 1) {
    if (!(await canConnect("127.0.0.1", port))) {
      console.log(`[Chaq] Production API port ${port} is stopped.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Port ${port} is still reachable after stop. `
    + `Check .logs\\${apiLogName} and .logs\\${workerLogName} for details.`
  );
}

async function waitForReady() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const status = await readReady();
    if (status.ready) return;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Chaq API did not become ready on http://127.0.0.1:${port}/api within 90 seconds.`);
}

function assertManagedWorkerRunning() {
  if (!productionWorkerRunning()) {
    throw new Error(`Chaq ${localPreview ? "preview" : "production"} Agent worker exited during startup. Check .logs\\${workerLogName}.`);
  }
}

async function main() {
  if (localPreview && publicBind) {
    throw new Error("--local-preview cannot be combined with --public; preview is loopback-only.");
  }
  if (statusOnly) {
    if (!(await printStatus())) process.exitCode = 1;
    return;
  }
  if (stopOnly || restart) {
    await stopProduction();
    if (stopOnly) return;
  }

  ensureEnvironmentFile();
  const envFile = localPreview ? previewEnv : process.env.CHAQ_ENV_FILE || serverEnv;
  const fileEnv = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, "utf8")) : {};
  const publicApiUrl = localPreview ? "http://127.0.0.1:24538/api" : resolvePublicApiUrl(fileEnv);
  const sourceEnv = localPreview ? { ...process.env, ...fileEnv } : { ...fileEnv, ...process.env };
  const env = {
    ...sourceEnv,
    NODE_ENV: "production",
    CHAQ_RUNTIME_PROFILE: runtimeProfile,
    CHAQ_ENV_FILE: envFile,
    CHAQ_SERVER_BIND: host,
    CHAQ_PROD_SERVER_PORT: String(port),
    SERVER_HOST: host,
    SERVER_PORT: String(port),
    CLIENT_ORIGIN: localPreview ? "http://127.0.0.1:27337" : resolveProductionClientOrigin(fileEnv),
    PUBLIC_API_URL: publicApiUrl,
    CHAQ_LOG_DIR: projectLogs,
    ...(localPreview ? {
      CHAQ_MAIL_MODE: "log",
      CHAQ_ALLOW_DEMO_SEED: "0",
      TRUST_PROXY: "",
      PAYMENT_ACCOUNT_NUMBER: "",
      SMTP_HOST: "",
      SMTP_USER: "",
      SMTP_PASS: "",
      SMTP_FROM: ""
    } : {})
  };
  run(process.execPath, ["scripts/validate-production-env.js", ...(localPreview ? ["--local-preview"] : [])], env);

  console.log(`[Chaq] Starting ${localPreview ? "local production preview" : "production"} API server and Agent worker (${host}:${port}).`);
  console.log(`[Chaq] Public API URL: ${publicApiUrl}`);
  if (!localPreview) console.log(`[Chaq] Cloudflared service target: http://127.0.0.1:${port}`);
  if (await assertPortAvailableOrReady()) {
    ensurePreviewAccount(env);
    ensureProductionWorker(env);
    return;
  }

  if (!fs.existsSync(path.join(root, "node_modules"))) {
    run(process.execPath, ["scripts/install-dependencies.js", "--server-only"], env);
  }

  run(command("npm"), ["run", "infra:local"], env);
  ensurePrismaClient(env);
  run(command("npm"), ["exec", "-w", "@chaq/server", "--", "prisma", "migrate", "deploy"], env);
  ensurePreviewAccount(env);

  if (!skipBuild || !fs.existsSync(path.join(root, "apps", "server", "dist", "src", "main.js"))) {
    run(command("npm"), ["run", "build", "-w", "@chaq/shared"], env);
    run(command("npm"), ["run", "build", "-w", "@chaq/server"], env);
  }

  if (foreground) {
    const children = [
      startForegroundProcess(
        `Chaq ${localPreview ? "preview" : "production"} API`,
        [productionEntries.api, ...runtimeMarkerArgs],
        apiLogName,
        env,
        "api"
      ),
      startForegroundProcess(
        `Chaq ${localPreview ? "preview" : "production"} Agent worker`,
        [productionEntries.worker, ...runtimeMarkerArgs],
        workerLogName,
        env,
        "worker"
      )
    ];
    writePid(apiPidFile, children[0].child.pid, "api");
    writePid(workerPidFile, children[1].child.pid, "worker");
    await waitForReady();
    assertManagedWorkerRunning();
    console.log(`[Chaq] ${localPreview ? "Local preview" : "Production"} API is ready on http://127.0.0.1:${port}/api.`);
    if (publicBind) {
      console.log(`[Chaq] Public bind is enabled on 0.0.0.0:${port}. Put Cloudflare Tunnel or a TLS reverse proxy in front of it before Internet exposure.`);
    }
    console.log("[Chaq] Production server is running in this window. Press Ctrl+C or close this window to stop it.");
    await keepForegroundAlive(children);
    return;
  }

  const apiPid = startProcess(
    `Chaq ${localPreview ? "preview" : "production"} API`,
    [productionEntries.api, ...runtimeMarkerArgs],
    apiLogName,
    env
  );
  writePid(apiPidFile, apiPid, "api");
  const workerPid = startProcess(
    `Chaq ${localPreview ? "preview" : "production"} Agent worker`,
    [productionEntries.worker, ...runtimeMarkerArgs],
    workerLogName,
    env
  );
  writePid(workerPidFile, workerPid, "worker");
  await waitForReady();
  assertManagedWorkerRunning();
  console.log(`[Chaq] ${localPreview ? "Local preview" : "Production"} API is ready on http://127.0.0.1:${port}/api.`);
  if (publicBind) {
    console.log(`[Chaq] Public bind is enabled on 0.0.0.0:${port}. Put Cloudflare Tunnel or a TLS reverse proxy in front of it before Internet exposure.`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.log(`[ERROR] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
