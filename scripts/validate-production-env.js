const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("./env-format");

const placeholderPattern = /(replace[-_ ]?with|change[-_ ]?me|changeme|example\.(com|invalid))/i;

function loadEnvironment(argv = process.argv.slice(2), baseEnvironment = process.env) {
  const envFileFlag = argv.indexOf("--env-file");
  const positionalFile = argv.find((value) => !value.startsWith("-"));
  const envFile = envFileFlag >= 0 ? argv[envFileFlag + 1] : positionalFile;
  if (!envFile) return { env: { ...baseEnvironment }, source: "process environment" };

  const resolved = path.resolve(envFile);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Environment file not found: ${resolved}`);
  }
  return {
    env: { ...parseEnv(fs.readFileSync(resolved, "utf8")), ...baseEnvironment },
    source: resolved
  };
}

function validateEnvironment(env, options = {}) {
  const localPreview = options.localPreview === true;
  const errors = [];
  const warnings = [];

  function value(name) {
    return String(env[name] ?? "").trim();
  }

  function required(name) {
    const current = value(name);
    if (!current) errors.push(`${name} is required.`);
    return current;
  }

  function rejectPlaceholder(name, current) {
    if (current && placeholderPattern.test(current)) {
      errors.push(`${name} still contains a template placeholder.`);
    }
  }

  function secret(name, minimumLength = 32) {
    const current = required(name);
    rejectPlaceholder(name, current);
    if (current && current.length < minimumLength) {
      errors.push(`${name} must contain at least ${minimumLength} characters.`);
    }
    return current;
  }

  function url(name, protocols, options = {}) {
    const current = required(name);
    if (!current) return null;
    try {
      const parsed = new URL(current);
      if (!protocols.includes(parsed.protocol)) {
        errors.push(`${name} must use ${protocols.join(" or ")}.`);
      }
      if (options.originOnly && (parsed.pathname !== "/" || parsed.search || parsed.hash)) {
        errors.push(`${name} must be an origin without a path, query, or fragment.`);
      }
      return parsed;
    } catch {
      errors.push(`${name} must be a valid URL.`);
      return null;
    }
  }

  function positiveInteger(name, fallback) {
    const current = value(name) || String(fallback);
    const parsed = Number(current);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      errors.push(`${name} must be a positive integer.`);
    }
    return parsed;
  }

  function positiveNumber(name, fallback) {
    const current = value(name) || String(fallback);
    const parsed = Number(current);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      errors.push(`${name} must be a positive number.`);
    }
    return parsed;
  }

  function port(name, fallback) {
    const parsed = positiveInteger(name, fallback);
    if (parsed > 65535) errors.push(`${name} must not exceed 65535.`);
    return parsed;
  }

  if (value("NODE_ENV") !== "production") {
    errors.push("NODE_ENV must be production.");
  }
  if (value("CHAQ_ALLOW_DEMO_SEED") === "1") {
    errors.push("CHAQ_ALLOW_DEMO_SEED must not be enabled in production.");
  }

  const database = url("DATABASE_URL", ["postgresql:", "postgres:"]);
  if (database) {
    if (!database.username) errors.push("DATABASE_URL must include a database user.");
    if (!database.password) errors.push("DATABASE_URL must include a database password.");
    rejectPlaceholder("DATABASE_URL", database.password);
    if (database.password && database.password.length < 12) {
      warnings.push("DATABASE_URL uses a short password; use a long random password outside local-only deployments.");
    }
  }
  const redis = url("REDIS_URL", ["redis:", "rediss:"]);

  const origins = required("CLIENT_ORIGIN").split(",").map((item) => item.trim()).filter(Boolean);
  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.pathname !== "/" || parsed.search || parsed.hash) {
        errors.push("CLIENT_ORIGIN entries must be HTTP(S) origins without paths, queries, or fragments.");
        break;
      }
      if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
        warnings.push("CLIENT_ORIGIN contains a non-HTTPS, non-loopback origin.");
      }
    } catch {
      errors.push("CLIENT_ORIGIN entries must be valid URLs.");
      break;
    }
  }

  const publicApi = url("PUBLIC_API_URL", ["http:", "https:"]);
  if (publicApi) {
    if (publicApi.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(publicApi.hostname)) {
      warnings.push("PUBLIC_API_URL is not protected by HTTPS.");
    }
    if (!publicApi.pathname.replace(/\/$/, "").endsWith("/api")) {
      warnings.push("PUBLIC_API_URL normally ends with /api.");
    }
  }

  const modelSecret = secret("MODEL_SECRET_KEY");
  const sessionSecret = secret("SESSION_HASH_SECRET");
  if (modelSecret && sessionSecret && modelSecret === sessionSecret) {
    errors.push("MODEL_SECRET_KEY and SESSION_HASH_SECRET must be different secrets.");
  }

  const runtimeProfile = value("CHAQ_RUNTIME_PROFILE");
  const mailMode = value("CHAQ_MAIL_MODE");
  if (localPreview) {
    if (runtimeProfile !== "local-preview") errors.push("CHAQ_RUNTIME_PROFILE must be local-preview.");
    if (mailMode !== "log") errors.push("CHAQ_MAIL_MODE must be log in local preview.");
    for (const name of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"]) {
      if (value(name)) errors.push(`${name} must be empty in local preview.`);
    }
    warnings.push("Local preview mail delivery writes verification codes to the project API log.");
  } else {
    if (runtimeProfile && runtimeProfile !== "standard") errors.push("CHAQ_RUNTIME_PROFILE must be empty or standard in formal production.");
    if (mailMode) errors.push("CHAQ_MAIL_MODE must be empty in formal production.");
    const smtpHost = required("SMTP_HOST");
    const smtpUser = required("SMTP_USER");
    const smtpPass = required("SMTP_PASS");
    const smtpFrom = required("SMTP_FROM");
    for (const [name, current] of [["SMTP_HOST", smtpHost], ["SMTP_USER", smtpUser], ["SMTP_PASS", smtpPass], ["SMTP_FROM", smtpFrom]]) {
      rejectPlaceholder(name, current);
    }
    port("SMTP_PORT", 465);
    const smtpSecure = value("SMTP_SECURE") || "1";
    const smtpStartTls = value("SMTP_STARTTLS") || "0";
    if (!["0", "1"].includes(smtpSecure)) errors.push("SMTP_SECURE must be 0 or 1.");
    if (!["0", "1"].includes(smtpStartTls)) errors.push("SMTP_STARTTLS must be 0 or 1.");
    if (smtpSecure === "0" && smtpStartTls === "0") {
      errors.push("SMTP must use either implicit TLS or STARTTLS in production.");
    }
  }

  const serverHost = required("SERVER_HOST");
  port("SERVER_PORT", 24537);
  const trustProxy = value("TRUST_PROXY");
  if (trustProxy.toLowerCase() === "true") {
    errors.push("TRUST_PROXY=true is unsafe; use a hop count or explicit proxy subnet.");
  } else if (/^\d+$/.test(trustProxy)) {
    const hops = Number(trustProxy);
    if (hops < 1 || hops > 10) errors.push("TRUST_PROXY hop count must be between 1 and 10.");
  } else if (trustProxy && trustProxy.split(",").some((entry) => !entry.trim())) {
    errors.push("TRUST_PROXY must contain non-empty comma-separated proxy subnets.");
  }
  positiveInteger("AGENT_WORKER_CONCURRENCY", 4);
  positiveInteger("MODEL_REQUEST_TIMEOUT_MS", 60000);

  if (value("PAYMENT_ACCOUNT_NUMBER")) {
    required("PAYMENT_BANK_NAME");
    required("PAYMENT_ACCOUNT_NAME");
    positiveNumber("PAYMENT_CNY_PER_M_TOKEN", 1);
    const minimum = positiveNumber("PAYMENT_MIN_M_TOKEN", 1);
    const maximum = positiveNumber("PAYMENT_MAX_M_TOKEN", 500);
    if (minimum > maximum) errors.push("PAYMENT_MIN_M_TOKEN must not exceed PAYMENT_MAX_M_TOKEN.");
    positiveInteger("PAYMENT_ORDER_EXPIRES_MINUTES", 1440);
  }

  if (localPreview) {
    if (!isLoopbackHostname(serverHost)) errors.push("SERVER_HOST must be a loopback host in local preview.");
    if (database && !isLoopbackHostname(database.hostname)) errors.push("DATABASE_URL must use a loopback host in local preview.");
    if (redis && !isLoopbackHostname(redis.hostname)) errors.push("REDIS_URL must use a loopback host in local preview.");
    if (publicApi && !isLoopbackHostname(publicApi.hostname)) errors.push("PUBLIC_API_URL must use a loopback host in local preview.");
    if (origins.some((origin) => {
      try {
        return !isLoopbackHostname(new URL(origin).hostname);
      } catch {
        return true;
      }
    })) {
      errors.push("CLIENT_ORIGIN must contain only loopback origins in local preview.");
    }
    if (trustProxy) errors.push("TRUST_PROXY must be empty in local preview.");
    if (value("PAYMENT_ACCOUNT_NUMBER")) errors.push("Payments must remain disabled in local preview.");
  }

  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

function isLoopbackHostname(hostname) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(String(hostname || "").trim().toLowerCase());
}

function validateProductionEnv(env) {
  return validateEnvironment(env, { localPreview: false });
}

function validateLocalPreviewEnv(env) {
  return validateEnvironment(env, { localPreview: true });
}

function assertProductionEnv(env) {
  const result = validateProductionEnv(env);
  if (result.errors.length) {
    const error = new Error(
      `Production environment validation failed with ${result.errors.length} error(s): ${result.errors.join(" ")}`
    );
    error.validationResult = result;
    throw error;
  }
  return result;
}

function assertLocalPreviewEnv(env) {
  const result = validateLocalPreviewEnv(env);
  if (result.errors.length) {
    const error = new Error(
      `Local preview environment validation failed with ${result.errors.length} error(s): ${result.errors.join(" ")}`
    );
    error.validationResult = result;
    throw error;
  }
  return result;
}

function main() {
  let loaded;
  try {
    loaded = loadEnvironment();
  } catch (error) {
    console.error(`[env:error] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const localPreview = process.argv.includes("--local-preview");
  const result = localPreview ? validateLocalPreviewEnv(loaded.env) : validateProductionEnv(loaded.env);
  for (const warning of result.warnings) console.warn(`[env:warn] ${warning}`);
  if (result.errors.length) {
    for (const error of result.errors) console.error(`[env:error] ${error}`);
    console.error(`[env:error] ${localPreview ? "Local preview" : "Production"} environment validation failed with ${result.errors.length} error(s).`);
    process.exit(1);
  }
  console.log(`[env] ${localPreview ? "Local preview" : "Production"} environment is valid (${loaded.source}).`);
}

if (require.main === module) main();

module.exports = {
  assertLocalPreviewEnv,
  assertProductionEnv,
  loadEnvironment,
  parseEnv,
  validateLocalPreviewEnv,
  validateProductionEnv
};
