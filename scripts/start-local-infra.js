const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseEnv } = require("./env-format");
const { ensureDockerEngine } = require("./ensure-docker-engine");
const {
  chaqEnvironmentRoot,
  dockerConfig,
  postgresData,
  postgresLog,
  projectRoot,
  serverEnv
} = require("./env-paths");

const postgresTools = ["initdb", "pg_ctl", "pg_isready", "psql", "createdb"];

function readEnv() {
  const envFile = process.env.CHAQ_ENV_FILE || serverEnv;
  if (!fs.existsSync(envFile)) {
    throw new Error(`Chaq env file not found: ${envFile}. Run npm run env:prepare first.`);
  }
  return { envFile, values: parseEnv(fs.readFileSync(envFile, "utf8")) };
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd || projectRoot,
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    windowsHide: true
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const details = options.capture ? `${result.stdout || ""}${result.stderr || ""}`.trim() : "";
    throw new Error(`${path.basename(file)} ${args.join(" ")} failed with exit code ${result.status}${details ? `: ${details}` : ""}`);
  }
  return result.stdout?.trim() ?? "";
}

function serviceExists(name) {
  const result = spawnSync("sc.exe", ["query", name], {
    stdio: "pipe",
    encoding: "utf8",
    windowsHide: true
  });
  return result.status === 0;
}

function serviceUsesPort(name, port) {
  const result = spawnSync("sc.exe", ["qc", name], {
    stdio: "pipe",
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    return false;
  }
  return result.stdout.includes(`-p ${port}`);
}

function readPostmasterRecord(pgData) {
  const pidFile = path.join(pgData, "postmaster.pid");
  if (!fs.existsSync(pidFile)) {
    return null;
  }
  const raw = fs.readFileSync(pidFile, "utf8");
  const lines = raw.split(/\r?\n/);
  const pid = Number(lines[0]);
  const port = Number(lines[3]);
  return {
    pidFile,
    raw,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    port: Number.isInteger(port) && port > 0 ? port : null
  };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    // Access denied still means that a process owns the PID. Err on the side of
    // preserving the file rather than deleting a live server's ownership record.
    return true;
  }
}

function postgresDataDirectoryIsRunning(pgCtl, pgData, spawn = spawnSync) {
  const result = spawn(pgCtl, ["status", "-D", pgData], {
    stdio: "pipe",
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

function reconcilePostmasterPid(pgData, pgCtl, options = {}) {
  const record = readPostmasterRecord(pgData);
  if (!record) return null;

  const pgCtlRunning = (options.postgresDataDirectoryIsRunning || postgresDataDirectoryIsRunning)(
    pgCtl,
    pgData,
    options.spawn || spawnSync
  );
  if (pgCtlRunning) {
    return { ...record, running: true, staleRemoved: false };
  }

  const pidAlive = (options.processIsAlive || processIsAlive)(record.pid);
  if (pidAlive) {
    throw new Error(
      `PostgreSQL ownership file ${record.pidFile} references live PID ${record.pid}, `
      + "but pg_ctl does not recognize it. Refusing to remove the file; stop that process or verify the data directory manually."
    );
  }

  // Re-read immediately before unlinking so a concurrently starting PostgreSQL
  // cannot have its freshly written ownership record removed by this process.
  const latest = fs.existsSync(record.pidFile) ? fs.readFileSync(record.pidFile, "utf8") : null;
  if (latest !== record.raw) {
    throw new Error(`PostgreSQL ownership file changed while it was being verified: ${record.pidFile}. Retry startup.`);
  }
  fs.rmSync(record.pidFile);
  console.warn(`[WARN] Removed stale PostgreSQL ownership file after confirming pg_ctl is stopped and PID ${record.pid ?? "unknown"} is not alive: ${record.pidFile}`);
  return { ...record, running: false, staleRemoved: true };
}

function canConnect(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(1200);
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

function redisPing(port, host = "127.0.0.1", timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    let response = "";
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };

    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => socket.write("*1\r\n$4\r\nPING\r\n"));
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.startsWith("+PONG\r\n")) finish(true);
      else if (response.includes("\r\n")) finish(false);
    });
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(response.startsWith("+PONG\r\n")));
  });
}

async function waitForPort(port, label) {
  for (let index = 0; index < 25; index += 1) {
    if (await canConnect(port)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${label} did not open 127.0.0.1:${port} in time.`);
}

async function waitForRedis(port) {
  for (let index = 0; index < 25; index += 1) {
    if (await redisPing(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Redis did not answer PING on 127.0.0.1:${port} in time. Check Docker Compose logs for the redis service.`);
}

function postgresExe(pgBin, name) {
  const extension = process.platform === "win32" ? ".exe" : "";
  const fullPath = path.join(pgBin, `${name}${extension}`);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`${name}.exe not found in ${pgBin}`);
  }
  return fullPath;
}

function postgresBinIsComplete(directory, platform = process.platform, exists = fs.existsSync) {
  if (!directory) return false;
  const extension = platform === "win32" ? ".exe" : "";
  return postgresTools.every((name) => exists(path.join(directory, `${name}${extension}`)));
}

function pathDirectories(environment = process.env, platform = process.platform) {
  const raw = platform === "win32"
    ? environment.Path || environment.PATH || ""
    : environment.PATH || "";
  const delimiter = platform === "win32" ? ";" : ":";
  return String(raw).split(delimiter).map((entry) => entry.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

function resolvePostgresBin(env, options = {}) {
  const platform = options.platform || process.platform;
  const exists = options.exists || fs.existsSync;
  const fallback = options.projectBin || path.join(chaqEnvironmentRoot, "postgresql", "bin");
  const candidates = [env.CHAQ_PG_BIN, fallback, ...pathDirectories(options.environment || process.env, platform)]
    .filter(Boolean)
    .filter((candidate, index, list) => list.indexOf(candidate) === index);
  const resolved = candidates.find((candidate) => postgresBinIsComplete(candidate, platform, exists));
  if (resolved) return resolved;
  throw new Error(
    `PostgreSQL tools (${postgresTools.join(", ")}) were not found. `
    + `Install PostgreSQL on a non-system drive or place its bin directory at ${fallback}, then add it to PATH.`
  );
}

async function startPostgres(env) {
  const pgBin = resolvePostgresBin(env);
  const pgData = env.CHAQ_PG_DATA_DIR || postgresData;
  const pgUser = env.CHAQ_PG_USER || "chaq";
  const pgPassword = env.CHAQ_PG_PASSWORD || "chaq";
  const pgDatabase = env.CHAQ_PG_DATABASE || "chaq";
  const pgPort = Number(env.CHAQ_PG_PORT || new URL(env.DATABASE_URL).port || 45432);
  const passwordFile = path.join(path.dirname(pgData), "postgres-password.tmp");

  fs.mkdirSync(pgData, { recursive: true });
  fs.mkdirSync(path.dirname(postgresLog), { recursive: true });

  const initdb = postgresExe(pgBin, "initdb");
  const pgCtl = postgresExe(pgBin, "pg_ctl");
  const pgIsReady = postgresExe(pgBin, "pg_isready");
  const psql = postgresExe(pgBin, "psql");
  const createdb = postgresExe(pgBin, "createdb");
  const serviceName = env.CHAQ_PG_SERVICE_NAME || "ChaqPostgreSQL";

  if (!fs.existsSync(path.join(pgData, "PG_VERSION"))) {
    console.log(`[Chaq] Initializing local PostgreSQL data at ${pgData}`);
    fs.writeFileSync(passwordFile, pgPassword, "utf8");
    try {
      run(initdb, ["-D", pgData, "-U", pgUser, "--pwfile", passwordFile, "-A", "scram-sha-256", "-E", "UTF8"]);
    } finally {
      fs.rmSync(passwordFile, { force: true });
    }
  }

  const postmaster = reconcilePostmasterPid(pgData, pgCtl);

  const ready = spawnSync(pgIsReady, ["-h", "127.0.0.1", "-p", String(pgPort), "-U", pgUser], {
    encoding: "utf8",
    env: { ...process.env, PGPASSWORD: pgPassword },
    windowsHide: true
  });
  if (ready.status !== 0) {
    const runningPort = postmaster?.running ? postmaster.port : null;
    if (runningPort && runningPort !== pgPort) {
      console.warn(`[WARN] PostgreSQL is running from ${pgData} on port ${runningPort}, but Chaq now expects ${pgPort}.`);
      console.warn(`[WARN] Stop the old process with: "${pgCtl}" stop -D "${pgData}" -m fast -w`);
      throw new Error(`PostgreSQL is running on the old port ${runningPort}. Stop it before starting Chaq on ${pgPort}.`);
    }

    if (postmaster?.running) {
      console.log(`[Chaq] PostgreSQL process from ${pgData} is starting on 127.0.0.1:${pgPort}`);
    } else if (serviceExists(serviceName) && serviceUsesPort(serviceName, pgPort)) {
      console.log(`[Chaq] Starting PostgreSQL Windows service ${serviceName} on 127.0.0.1:${pgPort}`);
      try {
        run("sc.exe", ["start", serviceName]);
      } catch (error) {
        console.warn(`[WARN] Could not start ${serviceName}; falling back to pg_ctl for this session.`);
        console.warn(`[WARN] ${error instanceof Error ? error.message : String(error)}`);
        run(pgCtl, ["-D", pgData, "-l", postgresLog, "-o", `-p ${pgPort} -h 127.0.0.1`, "start", "-w"], {
          env: { PGPASSWORD: pgPassword }
        });
      }
    } else {
      if (serviceExists(serviceName)) {
        console.warn(`[WARN] PostgreSQL service ${serviceName} exists but is not configured for port ${pgPort}.`);
        console.warn(`[WARN] Re-register it later if you want Windows service auto-start on the new port.`);
      }
      console.log(`[Chaq] Starting local PostgreSQL on 127.0.0.1:${pgPort}`);
      run(pgCtl, ["-D", pgData, "-l", postgresLog, "-o", `-p ${pgPort} -h 127.0.0.1`, "start", "-w"], {
        env: { PGPASSWORD: pgPassword }
      });
    }
  } else {
    console.log(`[Chaq] Local PostgreSQL is already ready on 127.0.0.1:${pgPort}`);
  }

  await waitForPort(pgPort, "PostgreSQL");
  const exists = run(psql, ["-h", "127.0.0.1", "-p", String(pgPort), "-U", pgUser, "-d", "postgres", "-tAc", `SELECT 1 FROM pg_database WHERE datname='${pgDatabase.replace(/'/g, "''")}'`], {
    capture: true,
    env: { PGPASSWORD: pgPassword }
  });
  if (exists.trim() !== "1") {
    console.log(`[Chaq] Creating PostgreSQL database ${pgDatabase}`);
    run(createdb, ["-h", "127.0.0.1", "-p", String(pgPort), "-U", pgUser, pgDatabase], {
      env: { PGPASSWORD: pgPassword }
    });
  }
}

async function startRedis(env) {
  const redisPort = Number(env.CHAQ_REDIS_PORT || new URL(env.REDIS_URL).port || 46379);
  const localPreview = env.CHAQ_RUNTIME_PROFILE === "local-preview";
  const alreadyRedis = await redisPing(redisPort);
  if (alreadyRedis && !localPreview) {
    console.log(`[Chaq] Docker Redis answered PING on 127.0.0.1:${redisPort}`);
    return;
  }
  if (!alreadyRedis && await canConnect(redisPort)) {
    throw new Error(
      `Port 127.0.0.1:${redisPort} is occupied, but the listener did not answer Redis PING. `
      + "Stop the conflicting process or change CHAQ_REDIS_PORT before starting Chaq."
    );
  }

  console.log(`[Chaq] Starting Redis with Docker Compose on 127.0.0.1:${redisPort}`);
  fs.mkdirSync(dockerConfig, { recursive: true });
  const engine = await ensureDockerEngine({
    environment: { ...process.env, DOCKER_CONFIG: process.env.DOCKER_CONFIG || dockerConfig },
    log: (message) => console.log(message)
  });
  const dockerEnvironment = engine.dockerEnvironment;
  const composeFile = path.join(projectRoot, "docker-compose.yml");
  const composeArgs = [
    "compose",
    "--project-name", "chaq-preview",
    "--file", composeFile
  ];
  if (localPreview) stopExposedLegacyPostgres(dockerEnvironment, composeFile);
  if (localPreview && alreadyRedis) {
    migrateLegacyRedisContainer(composeArgs, dockerEnvironment, composeFile);
  }
  run("docker", [...composeArgs, "up", "-d", "redis"], {
    env: dockerEnvironment
  });
  await waitForRedis(redisPort);
  if (localPreview) verifyRedisDockerBinding(composeArgs, dockerEnvironment, redisPort);
}

function dockerPortsExposeAllInterfaces(metadata) {
  const ports = metadata?.NetworkSettings?.Ports || {};
  return Object.values(ports).some((mappings) => Array.isArray(mappings) && mappings.some((mapping) => {
    const host = String(mapping?.HostIp || "").toLowerCase();
    return host === "0.0.0.0" || host === "::";
  }));
}

function stopExposedLegacyPostgres(dockerEnvironment, composeFile) {
  const output = run("docker", [
    "ps",
    "--filter", "label=com.docker.compose.project=chaq",
    "--filter", "label=com.docker.compose.service=postgres",
    "--format", "{{.ID}}"
  ], { capture: true, env: dockerEnvironment });
  const containerIds = output.split(/\s+/).filter(Boolean);
  for (const containerId of containerIds) {
    const metadata = inspectDockerContainer(containerId, dockerEnvironment);
    if (!containerBelongsToCompose(metadata, "chaq", "postgres", composeFile)) continue;
    if (!dockerPortsExposeAllInterfaces(metadata)) continue;
    console.warn(
      `[WARN] Stopping obsolete legacy PostgreSQL container ${containerId} because it exposes a project database on all interfaces. `
      + "Its named data volume is preserved; local preview uses the project-relative PostgreSQL instance on 127.0.0.1:45432."
    );
    run("docker", ["stop", containerId], { env: dockerEnvironment });
  }
}

function containerBelongsToCompose(metadata, expectedProject, expectedService, expectedFile) {
  const labels = metadata?.Config?.Labels || {};
  const configuredFiles = String(labels["com.docker.compose.project.config_files"] || "")
    .split(",")
    .map((file) => file.trim())
    .filter(Boolean);
  const normalize = (file) => process.platform === "win32"
    ? path.resolve(file).toLowerCase()
    : path.resolve(file);
  return labels["com.docker.compose.project"] === expectedProject
    && labels["com.docker.compose.service"] === expectedService
    && configuredFiles.some((file) => normalize(file) === normalize(expectedFile));
}

function inspectDockerContainer(containerId, dockerEnvironment) {
  const output = run("docker", ["inspect", containerId], { capture: true, env: dockerEnvironment });
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed[0] : null;
  } catch (error) {
    throw new Error(`Could not parse Docker metadata for container ${containerId}: ${error.message}`);
  }
}

function migrateLegacyRedisContainer(composeArgs, dockerEnvironment, composeFile) {
  const previewId = run("docker", [...composeArgs, "ps", "-q", "redis"], {
    capture: true,
    env: dockerEnvironment
  }).trim();
  if (previewId) return;

  const legacyArgs = [
    "compose",
    "--project-name", "chaq",
    "--file", composeFile
  ];
  const legacyId = run("docker", [...legacyArgs, "ps", "-q", "redis"], {
    capture: true,
    env: dockerEnvironment
  }).trim();
  if (!legacyId) {
    throw new Error(
      "Redis is already listening on the preview port, but it is not managed by the isolated chaq-preview Compose project. "
      + "Stop the conflicting Redis service before retrying."
    );
  }
  const metadata = inspectDockerContainer(legacyId, dockerEnvironment);
  if (!containerBelongsToCompose(metadata, "chaq", "redis", composeFile)) {
    throw new Error("The Redis listener belongs to a different Docker Compose configuration; refusing to replace it.");
  }
  console.log("[Chaq] Migrating the legacy Chaq Redis container into the isolated chaq-preview Compose project.");
  run("docker", [...legacyArgs, "stop", "redis"], { env: dockerEnvironment });
  run("docker", [...legacyArgs, "rm", "--force", "redis"], { env: dockerEnvironment });
}

function redisDockerBindingIsLoopback(value, expectedPort) {
  let ports;
  try {
    ports = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return false;
  }
  const mappings = ports?.["6379/tcp"];
  return Array.isArray(mappings)
    && mappings.length > 0
    && mappings.every((mapping) => {
      const host = String(mapping?.HostIp || "").toLowerCase();
      return ["127.0.0.1", "::1"].includes(host) && Number(mapping?.HostPort) === Number(expectedPort);
    });
}

function verifyRedisDockerBinding(composeArgs, dockerEnvironment, redisPort) {
  const containerId = run("docker", [...composeArgs, "ps", "-q", "redis"], {
    capture: true,
    env: dockerEnvironment
  }).trim();
  if (!containerId) throw new Error("Docker Compose did not report a Redis container after startup.");
  const ports = run("docker", ["inspect", "--format", "{{json .NetworkSettings.Ports}}", containerId], {
    capture: true,
    env: dockerEnvironment
  });
  if (!redisDockerBindingIsLoopback(ports, redisPort)) {
    throw new Error(
      `Redis Docker port ${redisPort} is not bound exclusively to loopback. `
      + "Refusing to continue local preview with an externally reachable Redis service."
    );
  }
  console.log(`[Chaq] Verified Docker Redis is bound only to 127.0.0.1:${redisPort}.`);
}

async function main() {
  const requestedEnvFile = process.env.CHAQ_ENV_FILE || serverEnv;
  if (!fs.existsSync(requestedEnvFile)) require("./prepare-env");
  const { envFile, values } = readEnv();
  console.log(`[Chaq] Loading local environment from ${envFile}`);
  await startPostgres(values);
  await startRedis(values);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[ERROR] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

module.exports = {
  pathDirectories,
  postgresBinIsComplete,
  containerBelongsToCompose,
  dockerPortsExposeAllInterfaces,
  readPostmasterRecord,
  reconcilePostmasterPid,
  redisDockerBindingIsLoopback,
  redisPing,
  resolvePostgresBin
};
