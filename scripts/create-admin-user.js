const fs = require("node:fs");
const path = require("node:path");
const { pbkdf2Sync, randomBytes } = require("node:crypto");
const { PrismaClient } = require("@prisma/client");
const { parseEnvEntries } = require("./env-format");

const root = path.resolve(__dirname, "..");
const iterations = 120_000;
const keyLength = 32;
const digest = "sha256";

function parseEnvFile(filePath, environment = process.env) {
  if (!filePath || !fs.existsSync(filePath)) return;
  for (const [key, value] of parseEnvEntries(fs.readFileSync(filePath, "utf8"))) {
    if (environment[key]) continue;
    environment[key] = value;
  }
}

function loadEnvironment() {
  if (process.env.CHAQ_ENV_FILE) {
    parseEnvFile(process.env.CHAQ_ENV_FILE);
    return;
  }

  try {
    const { serverEnv } = require("./env-paths");
    parseEnvFile(serverEnv);
  } catch {
    // Docker runtime images do not include local Windows env helpers.
  }

  parseEnvFile(path.join(root, ".env"));
  parseEnvFile(path.join(root, ".env.production"));
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const derived = pbkdf2Sync(password, salt, iterations, keyLength, digest).toString("hex");
  return `sha256:${iterations}:${salt}:${derived}`;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function assertPassword(password) {
  if (!/^(?=.*[A-Za-z])(?=.*\d).{8,64}$/.test(password)) {
    throw new Error("CHAQ_ADMIN_PASSWORD must be 8-64 characters and include at least one letter and one number.");
  }
}

function parseBalance(value) {
  if (!value) return 10000;
  const balance = Number(value);
  if (!Number.isInteger(balance) || balance < 0) {
    throw new Error("CHAQ_ADMIN_TOKEN_BALANCE must be a non-negative integer.");
  }
  return balance;
}

async function createUniqueUserId(prisma, username) {
  const base = String(username || "admin").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "admin";
  for (const id of [base, `admin-${randomBytes(5).toString("hex")}`]) {
    const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return id;
  }
  return `admin-${randomBytes(8).toString("hex")}`;
}

async function main() {
  loadEnvironment();

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required. Set CHAQ_ENV_FILE or run the production launcher first.");
  }

  const username = String(process.env.CHAQ_ADMIN_USERNAME || "admin").trim();
  const email = normalizeEmail(process.env.CHAQ_ADMIN_EMAIL);
  const password = String(process.env.CHAQ_ADMIN_PASSWORD || "");
  const displayName = String(process.env.CHAQ_ADMIN_DISPLAY_NAME || "Chaq Admin").trim();
  const tokenBalance = parseBalance(process.env.CHAQ_ADMIN_TOKEN_BALANCE);

  if (!username) throw new Error("CHAQ_ADMIN_USERNAME cannot be empty.");
  assertPassword(password);

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { username },
          ...(email ? [{ email }] : [])
        ]
      },
      select: { id: true, username: true, role: true }
    });

    if (existing) {
      const user = await prisma.user.update({
        where: { id: existing.id },
        data: {
          username,
          email: email || null,
          passwordHash: hashPassword(password),
          displayName,
          role: "ADMIN",
          tokenBalance
        },
        select: { id: true, username: true, role: true }
      });
      await prisma.userSetting.upsert({
        where: { userId: user.id },
        create: { userId: user.id },
        update: {}
      });
      console.log(`[admin] Updated ${user.username} (${user.id}) as ${user.role}.`);
      return;
    }

    const id = await createUniqueUserId(prisma, username);
    const user = await prisma.user.create({
      data: {
        id,
        username,
        email: email || null,
        passwordHash: hashPassword(password),
        displayName,
        role: "ADMIN",
        tokenBalance,
        settings: { create: {} }
      },
      select: { id: true, username: true, role: true }
    });
    console.log(`[admin] Created ${user.username} (${user.id}) as ${user.role}.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[ERROR] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

module.exports = { parseEnvFile };
