const fs = require("node:fs");
const { randomBytes } = require("node:crypto");
const path = require("node:path");
const { formatEnvValue, parseEnv } = require("./env-format");

function previewProjectPaths(projectRoot = path.resolve(__dirname, "..")) {
  const chaqEnvironmentRoot = path.join(projectRoot, ".chaq-data");
  return {
    chaqEnvironmentRoot,
    dockerConfig: path.join(chaqEnvironmentRoot, "docker-config"),
    postgresData: path.join(chaqEnvironmentRoot, "postgres-data"),
    previewEnv: path.join(chaqEnvironmentRoot, "preview.env"),
    projectLogs: path.join(projectRoot, ".logs"),
    redisData: path.join(chaqEnvironmentRoot, "redis-data")
  };
}

const {
  chaqEnvironmentRoot,
  dockerConfig,
  postgresData,
  previewEnv,
  projectLogs,
  redisData
} = previewProjectPaths();

function previewValues(existing = {}, createSecret = () => randomBytes(48).toString("base64url")) {
  const modelSecret = validSecret(existing.MODEL_SECRET_KEY) ? existing.MODEL_SECRET_KEY : createSecret();
  const sessionSecret = validSecret(existing.SESSION_HASH_SECRET) && existing.SESSION_HASH_SECRET !== modelSecret
    ? existing.SESSION_HASH_SECRET
    : createSecret();
  return {
    NODE_ENV: "production",
    CHAQ_RUNTIME_PROFILE: "local-preview",
    CHAQ_MAIL_MODE: "log",
    DATABASE_URL: "postgresql://chaq:chaq@127.0.0.1:45432/chaq_preview?schema=public",
    REDIS_URL: "redis://127.0.0.1:46379/1",
    SERVER_PORT: "24538",
    SERVER_HOST: "127.0.0.1",
    CLIENT_ORIGIN: "http://127.0.0.1:27337",
    PUBLIC_API_URL: "http://127.0.0.1:24538/api",
    TRUST_PROXY: "",
    CHAQ_ALLOW_DEMO_SEED: "0",
    AGENT_WORKER_CONCURRENCY: "4",
    MODEL_REQUEST_TIMEOUT_MS: "60000",
    CHAQ_LOG_DIR: projectLogs,
    CHAQ_PG_DATA_DIR: postgresData,
    CHAQ_PG_USER: "chaq",
    CHAQ_PG_PASSWORD: "chaq",
    CHAQ_PG_DATABASE: "chaq_preview",
    CHAQ_PG_PORT: "45432",
    CHAQ_PG_SERVICE_NAME: "ChaqPostgreSQL",
    CHAQ_REDIS_PORT: "46379",
    CHAQ_REDIS_DATA_DIR: redisData,
    DOCKER_CONFIG: dockerConfig,
    PAYMENT_ACCOUNT_NUMBER: "",
    MODEL_SECRET_KEY: modelSecret,
    SESSION_HASH_SECRET: sessionSecret,
    CHAQ_PREVIEW_USERNAME: validUsername(existing.CHAQ_PREVIEW_USERNAME) ? existing.CHAQ_PREVIEW_USERNAME : "preview",
    CHAQ_PREVIEW_PASSWORD: validPreviewPassword(existing.CHAQ_PREVIEW_PASSWORD)
      ? existing.CHAQ_PREVIEW_PASSWORD
      : `Chaq-${createSecret().slice(0, 18)}9`,
    CHAQ_PREVIEW_DISPLAY_NAME: String(existing.CHAQ_PREVIEW_DISPLAY_NAME || "Chaq Preview").trim() || "Chaq Preview",
    CHAQ_PREVIEW_TOKEN_BALANCE: validBalance(existing.CHAQ_PREVIEW_TOKEN_BALANCE)
      ? String(existing.CHAQ_PREVIEW_TOKEN_BALANCE)
      : "1000000"
  };
}

function validSecret(value) {
  return typeof value === "string" && value.trim().length >= 32;
}

function validUsername(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{2,32}$/.test(value.trim());
}

function validPreviewPassword(value) {
  return typeof value === "string" && /^(?=.*[A-Za-z])(?=.*\d).{8,64}$/.test(value);
}

function validBalance(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0;
}

function serializePreviewEnv(values) {
  return [
    "# Chaq local production preview environment (generated; project-local only)",
    ...Object.entries(values).map(([key, value]) => `${key}=${formatEnvValue(value)}`),
    ""
  ].join("\r\n");
}

function writePreviewEnvironment(filePath = previewEnv) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  for (const directory of [chaqEnvironmentRoot, dockerConfig, postgresData, projectLogs, redisData]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const existing = fs.existsSync(filePath) ? parseEnv(fs.readFileSync(filePath, "utf8")) : {};
  const values = previewValues(existing);
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, serializePreviewEnv(values), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  return { filePath, values };
}

function readPreviewLogin(filePath = previewEnv) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Local preview environment does not exist yet: ${filePath}`);
  }
  const values = parseEnv(fs.readFileSync(filePath, "utf8"));
  if (!validUsername(values.CHAQ_PREVIEW_USERNAME) || !validPreviewPassword(values.CHAQ_PREVIEW_PASSWORD)) {
    throw new Error(`Local preview login is missing or invalid in ${filePath}`);
  }
  return { filePath, values };
}

function main() {
  const showOnly = process.argv.includes("--show-login");
  const result = showOnly ? readPreviewLogin() : writePreviewEnvironment();
  console.log(`[Chaq] Local preview environment: ${result.filePath}`);
  if (showOnly) {
    console.log(`[Chaq] Preview login: ${result.values.CHAQ_PREVIEW_USERNAME} / ${result.values.CHAQ_PREVIEW_PASSWORD}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[ERROR] Could not prepare local preview environment: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = { parseEnv, previewProjectPaths, previewValues, readPreviewLogin, serializePreviewEnv, writePreviewEnvironment };
