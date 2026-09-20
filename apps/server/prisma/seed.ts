import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { demoPasswordHash } from "../src/modules/auth/auth.service";
const { assertDemoSeedAllowed } = require("../../../scripts/demo-seed-policy") as {
  assertDemoSeedAllowed: (env?: NodeJS.ProcessEnv) => void;
};

const envPath = join(__dirname, "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^"|"$/g, "");
  }
}

assertDemoSeedAllowed(process.env);

const prisma = new PrismaClient();

const defaultSettings = {
  language: "zh",
  theme: "light",
  backgroundUrl: null,
  backgroundOpacity: 0.42,
  windowOpacity: 1,
  notificationSound: true,
  iconFlash: true,
  localChatDataPath: ".chaq-data/user-data",
  fileStoragePath: ".chaq-data/files"
};

const demoUsers = [
  {
    id: process.env.DEMO_ADMIN_USER_ID ?? "admin-local",
    username: "admin",
    displayName: "Chaq Admin",
    role: "ADMIN" as const,
    avatarUrl: "/avatars/admin.png",
    tokenBalance: 9999
  }
];

async function ensureDemoUser(user: (typeof demoUsers)[number]): Promise<void> {
  const existingUser = await prisma.user.findFirst({
    where: {
      OR: [
        { id: user.id },
        { username: user.username }
      ]
    },
    select: { id: true, username: true }
  });

  if (!existingUser) {
    await prisma.user.create({
      data: {
        ...user,
        passwordHash: demoPasswordHash,
        settings: { create: defaultSettings as any }
      }
    });
    console.log(`[seed] Created demo user ${user.username}.`);
    return;
  }

  await prisma.userSetting.upsert({
    where: { userId: existingUser.id },
    create: {
      userId: existingUser.id,
      ...(defaultSettings as any)
    },
    update: {}
  });
  console.log(`[seed] Demo user ${existingUser.username} already exists; leaving fields unchanged.`);
}

async function ensureDemoProvider(): Promise<void> {
  const existingProvider = await prisma.modelProviderConfig.findUnique({
    where: { id: "demo-openai-compatible" },
    select: { id: true }
  });

  if (existingProvider) {
    console.log("[seed] Demo provider already exists; leaving fields unchanged.");
    return;
  }

  await prisma.modelProviderConfig.create({
    data: {
      id: "demo-openai-compatible",
      kind: "OPENAI",
      name: "Demo OpenAI Compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKeyCiphertext: "replace-me",
      models: [
        { id: "gpt-4.1-mini", label: "GPT 4.1 Mini", contextWindow: 128000 }
      ],
      enabled: false,
      promptTokenPrice: 0.001,
      completionTokenPrice: 0.004,
      contextWindow: 128000
    }
  });
  console.log("[seed] Created demo provider.");
}

async function main(): Promise<void> {
  for (const user of demoUsers) {
    await ensureDemoUser(user);
  }

  await ensureDemoProvider();
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
