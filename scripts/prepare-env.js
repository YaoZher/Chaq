const fs = require("node:fs");
const { randomBytes } = require("node:crypto");
const path = require("node:path");
const { formatDotenvValue, formatEnvValue, parseEnv } = require("./env-format");
const {
  chaqEnvironmentRoot,
  electronCache,
  npmCache,
  postgresData,
  projectLogs,
  runtimeCache,
  serverEnv,
  userData,
  workspaceServerEnv
} = require("./env-paths");

const requiredEnv = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://chaq:chaq@127.0.0.1:45432/chaq?schema=public",
  REDIS_URL: "redis://127.0.0.1:46379",
  SERVER_PORT: "24537",
  SERVER_HOST: "127.0.0.1",
  CLIENT_ORIGIN: "http://localhost:27337",
  DEMO_ADMIN_USER_ID: "admin-local",
  CHAQ_ALLOW_DEMO_SEED: "0",
  AGENT_WORKER_CONCURRENCY: "4",
  MODEL_REQUEST_TIMEOUT_MS: "60000",
  CHAQ_LOG_DIR: projectLogs,
  CHAQ_PG_BIN: path.join(chaqEnvironmentRoot, "postgresql", "bin"),
  CHAQ_PG_DATA_DIR: postgresData,
  CHAQ_PG_USER: "chaq",
  CHAQ_PG_PASSWORD: "chaq",
  CHAQ_PG_DATABASE: "chaq",
  CHAQ_PG_PORT: "45432",
  CHAQ_PG_SERVICE_NAME: "ChaqPostgreSQL",
  CHAQ_REDIS_PORT: "46379"
};

const secretEnv = {
  MODEL_SECRET_KEY: () => randomBytes(48).toString("base64url"),
  SESSION_HASH_SECRET: () => randomBytes(48).toString("base64url")
};

for (const dir of [chaqEnvironmentRoot, electronCache, runtimeCache, npmCache, postgresData, userData, projectLogs]) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeServerEnv() {
  const existingLines = fs.existsSync(serverEnv) ? fs.readFileSync(serverEnv, "utf8").split(/\r?\n/) : [];
  const seen = new Set();
  const existingSecrets = new Map();
  const nextLines = [];

  for (const line of existingLines) {
    const trimmed = line.trim();
    const index = trimmed.indexOf("=");
    if (!trimmed || trimmed.startsWith("#") || index < 1) {
      nextLines.push(line);
      continue;
    }

    const key = trimmed.slice(0, index).trim();
    if (key in secretEnv) {
      const value = parseEnv(trimmed)[key];
      if (value) {
        existingSecrets.set(key, value);
        nextLines.push(line);
        seen.add(key);
      }
      continue;
    }
    if (key in requiredEnv) {
      nextLines.push(`${key}=${formatEnvValue(requiredEnv[key])}`);
      seen.add(key);
    } else if (key !== "CHAQ_REDIS_SERVER") {
      nextLines.push(line);
    }
  }

  if (nextLines.length === 0) {
    nextLines.push("# Chaq local development environment");
  }

  for (const [key, value] of Object.entries(requiredEnv)) {
    if (!seen.has(key)) {
      nextLines.push(`${key}=${formatEnvValue(value)}`);
    }
  }

  for (const [key, createSecret] of Object.entries(secretEnv)) {
    if (seen.has(key)) continue;
    const value = createSecret();
    existingSecrets.set(key, value);
    nextLines.push(`${key}=${value}`);
  }

  const serverEnvText = `${nextLines.filter((line, index, lines) => line.trim() || index < lines.length - 1).join("\r\n")}\r\n`;
  try {
    fs.writeFileSync(serverEnv, serverEnvText, "utf8");
  } catch (error) {
    if (!fs.existsSync(serverEnv)) throw error;
    console.warn(`[WARN] Could not rewrite ${serverEnv}; using the existing file.`);
    console.warn(`[WARN] ${error instanceof Error ? error.message : String(error)}`);
  }
  writeWorkspaceServerEnv(existingSecrets);
}

function writeWorkspaceServerEnv(secrets) {
  const existingLines = fs.existsSync(workspaceServerEnv) ? fs.readFileSync(workspaceServerEnv, "utf8").split(/\r?\n/) : [];
  const seen = new Set();
  const nextLines = [];
  const values = { ...requiredEnv, ...Object.fromEntries(secrets.entries()) };
  for (const line of existingLines) {
    const trimmed = line.trim();
    const index = trimmed.indexOf("=");
    if (!trimmed || trimmed.startsWith("#") || index < 1) {
      nextLines.push(line);
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    if (key in values) {
      nextLines.push(`${key}=${formatDotenvValue(values[key])}`);
      seen.add(key);
    } else {
      nextLines.push(line);
    }
  }
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) nextLines.push(`${key}=${formatDotenvValue(value)}`);
  }
  fs.writeFileSync(workspaceServerEnv, `${nextLines.filter((line, index, lines) => line.trim() || index < lines.length - 1).join("\r\n")}\r\n`, "utf8");
}

writeServerEnv();

console.log(`Chaq environment root: ${chaqEnvironmentRoot}`);
console.log(`Electron cache: ${electronCache}`);
console.log(`Electron runtime cache: ${runtimeCache}`);
console.log(`npm cache: ${npmCache}`);
console.log(`Electron user data: ${userData}`);
console.log(`Server env: ${serverEnv}`);
console.log(`Workspace server env: ${workspaceServerEnv}`);
console.log(`Server logs: ${projectLogs}`);
