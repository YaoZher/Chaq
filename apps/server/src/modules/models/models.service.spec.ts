import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelCallPurpose,
  ModelCallReservationStatus,
  ModelProviderScope,
  ProviderKind,
  TokenTransactionKind
} from "@prisma/client";
import { ModelsService } from "./models.service";
import { WalletService } from "../billing/wallet.service";

function serviceWith(prisma: Record<string, unknown>): ModelsService {
  return new ModelsService(prisma as never, new WalletService(), { ensureUser: async () => ({ id: "user-1" }) } as never);
}

test("public provider listing is limited to enabled platform providers", async () => {
  let where: unknown;
  const service = serviceWith({
    modelProviderConfig: {
      findMany: async (input: { where: unknown }) => {
        where = input.where;
        return [];
      }
    }
  });

  await service.publicProviders();
  assert.deepEqual(where, { scope: ModelProviderScope.PLATFORM, enabled: true });
});

test("available provider listing includes platform and only the current user's private providers", async () => {
  let where: any;
  const service = serviceWith({
    modelProviderConfig: {
      findMany: async (input: { where: unknown }) => {
        where = input.where;
        return [];
      }
    }
  });

  await service.availableProviders("user-1");
  assert.equal(where.enabled, true);
  assert.deepEqual(where.OR, [
    { scope: ModelProviderScope.PLATFORM },
    { scope: ModelProviderScope.USER_PRIVATE, ownerId: "user-1" }
  ]);
});

test("provider projection exposes embedding metadata stored in model JSON", async () => {
  const provider = {
    id: "platform-embed",
    scope: ModelProviderScope.PLATFORM,
    ownerId: null,
    kind: ProviderKind.OPENAI,
    name: "Embedding Provider",
    baseUrl: "https://api.example.com/v1",
    apiKeyCiphertext: "hidden",
    models: [{ id: "chat-model", label: "Chat Model", contextWindow: 128000, embeddingModel: "text-embedding-3-small", embeddingTokenPrice: 0.002 }],
    enabled: true,
    promptTokenPrice: 0,
    completionTokenPrice: 0,
    contextWindow: 128000,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const service = serviceWith({
    modelProviderConfig: {
      findMany: async () => [provider]
    }
  });

  const [publicProvider] = await service.publicProviders();
  assert.equal(publicProvider.embeddingModel, "text-embedding-3-small");
  assert.equal(publicProvider.embeddingTokenPrice, 0.002);
});

test("agent embedding falls back when a provider has no embedding model", async () => {
  const service = serviceWith({
    agent: {
      findUnique: async () => ({ id: "agent-1", ownerId: "user-1", modelProviderId: null })
    }
  });

  const result = await service.agentEmbedding("agent-1", "hello vector world", "user-1");
  assert.equal(result.model, "chaq-hash-v1");
  assert.equal(result.fallback, true);
  assert.ok(result.vector.length > 0);
});

test("agent embedding calls OpenAI-compatible embeddings when configured", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: [{ embedding: [1, 2, 2] }]
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const service = serviceWith({
      agent: {
        findUnique: async () => ({ id: "agent-1", ownerId: "user-1", modelProviderId: "provider-1" })
      },
      modelProviderConfig: {
        findUnique: async () => ({
          id: "provider-1",
          scope: ModelProviderScope.PLATFORM,
          ownerId: null,
          kind: ProviderKind.OPENAI,
          name: "Provider",
          baseUrl: "https://api.example.com/v1",
          apiKeyCiphertext: "base64:a2V5",
          models: [{ id: "chat", label: "Chat", contextWindow: 1000, embeddingModel: "embed-small" }],
          enabled: true,
          promptTokenPrice: 0,
          completionTokenPrice: 0,
          contextWindow: 1000,
          createdAt: new Date(),
          updatedAt: new Date()
        })
      }
    }) as any;
    service.reserveModelCall = async () => ({
      state: "acquired",
      reservation: { id: "reservation-1", attempt: 1 }
    });
    service.settleModelCall = async () => ({
      reservation: { chargedTokens: 0 },
      balanceAfter: 100
    });

    const result = await service.agentEmbedding("agent-1", "semantic text", "user-1");
    assert.equal(result.model, "embed-small");
    assert.equal(result.fallback, false);
    assert.deepEqual(result.vector, [0.33333333, 0.66666667, 0.66666667]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("private providers cannot be used by public agents or another owner", async () => {
  const privateProvider = {
    id: "private-1",
    scope: ModelProviderScope.USER_PRIVATE,
    ownerId: "user-1",
    kind: ProviderKind.OPENAI,
    name: "Private",
    baseUrl: "https://api.openai.com/v1",
    apiKeyCiphertext: "hidden",
    models: [],
    enabled: true,
    promptTokenPrice: 0,
    completionTokenPrice: 0,
    contextWindow: 128000,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const service = serviceWith({
    modelProviderConfig: { findUnique: async () => privateProvider }
  });

  await service.assertAgentProviderAccess("user-1", "private-1", "private");
  await assert.rejects(
    service.assertAgentProviderAccess("user-1", "private-1", "public"),
    /Public and unlisted agents can only use platform model providers/
  );
  await assert.rejects(
    service.assertAgentProviderAccess("user-2", "private-1", "private"),
    /Enabled cloud model provider not found/
  );
});

test("zero-priced providers do not consume a minimum token charge", () => {
  const service = serviceWith({}) as any;
  assert.equal(service.calculateCharge({ promptTokenPrice: 0, completionTokenPrice: 0 }, 500, 500), 0);
  assert.equal(service.calculateCharge({ promptTokenPrice: 0.01, completionTokenPrice: 0 }, 1, 0), 1);
});

test("user-private providers reject local Ollama endpoints", async () => {
  const service = serviceWith({});
  await assert.rejects(
    service.upsertPrivateProvider("user-1", {
      kind: "ollama",
      name: "Local Ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModel: "llama3.2",
      contextWindow: 8192
    }),
    /must use a cloud API reachable by the server/
  );
});

test("provider base URLs reject credentials, queries, and fragments while platform HTTP remains configurable", () => {
  const service = serviceWith({}) as any;
  assert.equal(service.platformProviderBaseUrl("http://10.0.0.8:11434/v1/"), "http://10.0.0.8:11434/v1");
  assert.throws(() => service.platformProviderBaseUrl("https://user:pass@example.com/v1"), /embedded credentials/);
  assert.throws(() => service.platformProviderBaseUrl("https://example.com/v1?token=secret"), /query string or fragment/);
  assert.throws(() => service.platformProviderBaseUrl("https://example.com/v1#models"), /query string or fragment/);
});

test("Google API keys are sent in headers and never placed in provider URLs", async () => {
  const apiKey = "super-secret&key";
  const requests: Array<{ url: string; headers: Headers }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    const payload = url.endsWith(":embedContent")
      ? { embedding: { values: [1, 0] } }
      : {
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 }
        };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const provider = {
      id: "google-1",
      scope: ModelProviderScope.PLATFORM,
      ownerId: null,
      kind: ProviderKind.GOOGLE,
      name: "Google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKeyCiphertext: `base64:${Buffer.from(apiKey).toString("base64")}`,
      models: [{ id: "gemini-test", label: "Gemini", contextWindow: 1000, embeddingModel: "embed-test" }],
      enabled: true,
      promptTokenPrice: 0,
      completionTokenPrice: 0,
      contextWindow: 1000,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const service = serviceWith({}) as any;
    await service.callGoogle(provider, apiKey, "gemini-test", [{ role: "user", content: "hello" }], 20);
    await service.callEmbeddingProvider(provider, "embed-test", "hello");

    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.url.includes(apiKey), false);
      assert.equal(new URL(request.url).search, "");
      assert.equal(request.headers.get("x-goog-api-key"), apiKey);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("client model request keys are stable per user and isolated between users", () => {
  const service = serviceWith({}) as any;
  assert.equal(service.requestKey("cloud-chat", "user-1", "retry-key"), service.requestKey("cloud-chat", "user-1", "retry-key"));
  assert.notEqual(service.requestKey("cloud-chat", "user-1", "retry-key"), service.requestKey("cloud-chat", "user-2", "retry-key"));
});

test("model settlement refunds the unused hold and credits a service fee exactly once", async () => {
  let reservation: any = {
    id: "reservation-1",
    requestKey: "agent-run:run-1:completion",
    requestHash: "hash-1",
    attempt: 1,
    purpose: ModelCallPurpose.AGENT_COMPLETION,
    status: ModelCallReservationStatus.PENDING,
    userId: "payer-1",
    providerId: "provider-1",
    model: "model-1",
    reservedTokens: 100,
    chargedTokens: 0,
    promptTokenLimit: 80,
    completionTokenLimit: 20,
    promptTokens: 0,
    completionTokens: 0,
    serviceFee: 10,
    beneficiaryUserId: "owner-1",
    response: null,
    error: null,
    settledAt: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const charges: Array<{ amount: number; kind: TokenTransactionKind }> = [];
  const credits: Array<{ userId: string; amount: number }> = [];
  let logs = 0;
  const tx = {
    modelCallReservation: {
      findUniqueOrThrow: async () => reservation,
      updateMany: async ({ where, data }: any) => {
        if (reservation.status !== where.status || reservation.attempt !== where.attempt) return { count: 0 };
        reservation = { ...reservation, ...data };
        return { count: 1 };
      }
    },
    modelCallLog: { create: async () => { logs += 1; } },
    user: { findUniqueOrThrow: async () => ({ tokenBalance: 70 }) }
  };
  const wallet = {
    settleTokenReservationInTransaction: async (_tx: unknown, _userId: string, reserved: number, rows: any[]) => {
      assert.equal(reserved, 100);
      charges.push(...rows.map((row) => ({ amount: row.amount, kind: row.kind })));
      return 70;
    },
    creditTokensInTransaction: async (_tx: unknown, userId: string, amount: number) => {
      credits.push({ userId, amount });
      return 510;
    }
  };
  const service = new ModelsService({ $transaction: async (callback: any) => callback(tx) } as never, wallet as never, {} as never) as any;
  const input = {
    result: { content: "hello", promptTokens: 10, completionTokens: 5 },
    modelCharge: 20,
    serviceFee: 10,
    beneficiaryUserId: "owner-1",
    agentRunId: "run-1",
    agentId: "agent-1",
    response: { content: "hello", promptTokens: 10, completionTokens: 5, modelLabel: "Provider / model-1" },
    modelNote: "Agent run"
  };

  const first = await service.settleModelCall({ id: reservation.id, attempt: 1 }, input);
  const replay = await service.settleModelCall({ id: reservation.id, attempt: 1 }, input);

  assert.equal(first.reservation.chargedTokens, 30);
  assert.equal(replay.reservation.chargedTokens, 30);
  assert.deepEqual(charges, [
    { amount: 20, kind: TokenTransactionKind.AGENT_MODEL_USAGE },
    { amount: 10, kind: TokenTransactionKind.AGENT_SERVICE_FEE }
  ]);
  assert.deepEqual(credits, [{ userId: "owner-1", amount: 10 }]);
  assert.equal(logs, 1);
});

test("stale reservations are refunded, reclaimed with a new attempt, and reject the old attempt", async () => {
  let reservation: any = {
    id: "reservation-1",
    requestKey: "cloud-chat:key",
    requestHash: "hash-1",
    attempt: 1,
    purpose: ModelCallPurpose.CLOUD_CHAT,
    status: ModelCallReservationStatus.PENDING,
    userId: "user-1",
    providerId: "provider-1",
    model: "model-1",
    reservedTokens: 40,
    chargedTokens: 0,
    promptTokenLimit: 20,
    completionTokenLimit: 20,
    promptTokens: 0,
    completionTokens: 0,
    serviceFee: 0,
    beneficiaryUserId: null,
    response: null,
    error: null,
    settledAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0)
  };
  let releases = 0;
  let reserves = 0;
  const tx = {
    modelCallReservation: {
      findUnique: async () => reservation,
      findUniqueOrThrow: async () => reservation,
      updateMany: async ({ where, data }: any) => {
        if (where.id !== reservation.id || where.status !== reservation.status || where.attempt !== reservation.attempt) return { count: 0 };
        reservation = {
          ...reservation,
          ...data,
          attempt: data.attempt?.increment ? reservation.attempt + data.attempt.increment : reservation.attempt,
          updatedAt: new Date()
        };
        return { count: 1 };
      }
    },
    modelCallLog: { create: async () => undefined }
  };
  const wallet = {
    releaseTokenReservationInTransaction: async () => { releases += 1; return 100; },
    reserveTokensInTransaction: async () => { reserves += 1; return 60; }
  };
  const service = new ModelsService({ $transaction: async (callback: any) => callback(tx) } as never, wallet as never, {} as never) as any;
  service.pendingReservationStaleMs = () => 1;
  const claim = await service.reserveModelCall({
    requestKey: reservation.requestKey,
    requestHash: reservation.requestHash,
    purpose: reservation.purpose,
    userId: reservation.userId,
    providerId: reservation.providerId,
    model: reservation.model,
    reservedTokens: 40,
    promptTokenLimit: 20,
    completionTokenLimit: 20
  });
  await service.failModelCall({ id: reservation.id, attempt: 1 }, new Error("late old failure"), 2);

  assert.equal(claim.state, "acquired");
  assert.equal(claim.reservation.attempt, 2);
  assert.equal(reservation.status, ModelCallReservationStatus.PENDING);
  assert.equal(releases, 1);
  assert.equal(reserves, 1);
});
