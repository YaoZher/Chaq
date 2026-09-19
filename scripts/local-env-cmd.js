const fs = require("node:fs");
const { serverEnv } = require("./env-paths");
const { parseEnv } = require("./env-format");

const envFile = process.env.CHAQ_ENV_FILE || serverEnv;
if (!fs.existsSync(envFile)) {
  console.error(`Chaq env file not found: ${envFile}`);
  process.exit(1);
}

const entries = parseEnv(fs.readFileSync(envFile, "utf8"));
console.log(`set "CHAQ_ENV_FILE=${envFile}"`);
for (const [key, value] of Object.entries(entries)) {
  console.log(`set "${key}=${value}"`);
}
