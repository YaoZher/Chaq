import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  ModelCallLog,
  ModelCallPurpose,
  ModelCallReservation,
  ModelCallReservationStatus,
  ModelProviderConfig,
  ModelProviderScope,
  Prisma,
  ProviderKind,
  TokenTransactionKind
} from "@prisma/client";
import type { CloudChatRequest, CloudChatResponse, DistillRequest, DistillResponse, ModelProviderPublic, SkillDraft } from "@chaq/shared";
import { assertOutboundUrl, readResponseJsonLimited, safeFetch } from "../../common/outbound-http";
import { PrismaService } from "../../common/prisma.service";
import { embedText } from "../../common/vector-search";
import { WalletCharge, WalletService } from "../billing/wallet.service";
import { UserAccessService } from "../users/user-access.service";

type ProviderInput = {
  id?: string;
  kind: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  models: Array<{ id: string; label: string; contextWindow: number }>;
  embeddingModel?: string;
  embeddingTokenPrice?: number;
  enabled: boolean;
  promptTokenPrice: number;
  completionTokenPrice: number;
  contextWindow: number;
};

type PrivateProviderInput = {
  id?: string;
  kind: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  defaultModel: string;
  embeddingModel?: string;
  contextWindow?: number;
};

type ProviderCallResult = {
  content: string;
  promptTokens: number;
  completionTokens: number;
};

type ProviderCallBudget = {
  promptTokenLimit: number;
  completionTokenLimit: number;
};

type ReservationClaim =
  | { state: "acquired"; reservation: ModelCallReservation }
  | { state: "pending"; reservation: ModelCallReservation }
  | { state: "settled"; reservation: ModelCallReservation };

type StoredCompletionResponse = ProviderCallResult & {
  modelLabel: string;
};

type StoredEmbeddingResponse = EmbeddingResult;

const maxProviderResponseBytes = 2 * 1024 * 1024;

export type AgentCompletionResult = ProviderCallResult & {
  chargedTokens: number;
  balanceAfter: number;
  modelLabel: string;
};

export type EmbeddingResult = {
  vector: number[];
  model: string;
  providerId?: string;
  fallback: boolean;
  promptTokens: number;
  chargedTokens: number;
};

@Injectable()
export class ModelsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WalletService) private readonly wallet: WalletService,
    @Inject(UserAccessService) private readonly userAccess: UserAccessService
  ) {}

  async publicProviders(): Promise<ModelProviderPublic[]> {
    const providers = await this.prisma.modelProviderConfig.findMany({
      where: { scope: ModelProviderScope.PLATFORM, enabled: true },
      orderBy: { createdAt: "asc" }
    });
    return providers.map((provider) => this.toPublicProvider(provider));
  }

  async adminProviders(userId: string): Promise<ModelProviderPublic[]> {
    await this.userAccess.assertAdmin(userId);
    const providers = await this.prisma.modelProviderConfig.findMany({
      where: { scope: ModelProviderScope.PLATFORM },
      orderBy: { createdAt: "desc" }
    });
    return providers.map((provider) => this.toPublicProvider(provider));
  }

  async upsertProvider(userId: string, input: ProviderInput): Promise<ModelProviderPublic> {
    await this.userAccess.assertAdmin(userId);
    const baseUrl = this.platformProviderBaseUrl(input.baseUrl);
    const trimmedApiKey = input.apiKey?.trim() ?? "";
    const existing = input.id
      ? await this.prisma.modelProviderConfig.findFirst({ where: { id: input.id, scope: ModelProviderScope.PLATFORM } })
      : null;
    if (input.id && !existing) throw new NotFoundException("Platform model provider not found.");
    if (!existing && !trimmedApiKey && input.kind.toLowerCase() !== "ollama") {
      throw new BadRequestException("Provider API key is required when creating a cloud model provider.");
    }
    const data = {
      scope: ModelProviderScope.PLATFORM,
      ownerId: null,
      kind: this.toPrismaProviderKind(input.kind),
      name: input.name,
      baseUrl,
      apiKeyCiphertext: trimmedApiKey ? this.sealApiKey(trimmedApiKey) : existing?.apiKeyCiphertext ?? "",
      models: this.withEmbeddingMetadata(input.models, input.embeddingModel, input.embeddingTokenPrice),
      enabled: input.enabled,
      promptTokenPrice: input.promptTokenPrice,
      completionTokenPrice: input.completionTokenPrice,
      contextWindow: input.contextWindow
    };
    const provider = input.id
      ? await this.prisma.modelProviderConfig.update({ where: { id: input.id }, data })
      : await this.prisma.modelProviderConfig.create({ data });
    return this.toPublicProvider(provider);
  }

  async updateProviderStatus(userId: string, id: string, enabled: boolean): Promise<ModelProviderPublic> {
    await this.userAccess.assertAdmin(userId);
    const existing = await this.prisma.modelProviderConfig.findFirst({ where: { id, scope: ModelProviderScope.PLATFORM } });
    if (!existing) throw new NotFoundException("Platform model provider not found.");
    const provider = await this.prisma.modelProviderConfig.update({ where: { id }, data: { enabled } });
    return this.toPublicProvider(provider);
  }

  async availableProviders(userId: string): Promise<ModelProviderPublic[]> {
    await this.userAccess.ensureUser(userId);
    const providers = await this.prisma.modelProviderConfig.findMany({
      where: {
        enabled: true,
        OR: [
          { scope: ModelProviderScope.PLATFORM },
          { scope: ModelProviderScope.USER_PRIVATE, ownerId: userId }
        ]
      },
      orderBy: [{ scope: "asc" }, { createdAt: "asc" }]
    });
    return providers.map((provider) => this.toPublicProvider(provider));
  }

  async privateProviders(userId: string): Promise<ModelProviderPublic[]> {
    await this.userAccess.ensureUser(userId);
    const providers = await this.prisma.modelProviderConfig.findMany({
      where: { scope: ModelProviderScope.USER_PRIVATE, ownerId: userId },
      orderBy: { updatedAt: "desc" }
    });
    return providers.map((provider) => this.toPublicProvider(provider));
  }

  async upsertPrivateProvider(userId: string, input: PrivateProviderInput): Promise<ModelProviderPublic> {
    await this.userAccess.ensureUser(userId);
    if (input.kind.toLowerCase() === "ollama") {
      throw new BadRequestException("Private model providers must use a cloud API reachable by the server.");
    }
    const baseUrl = await this.privateProviderBaseUrl(input.baseUrl);
    const existing = input.id
      ? await this.prisma.modelProviderConfig.findFirst({
        where: { id: input.id, scope: ModelProviderScope.USER_PRIVATE, ownerId: userId }
      })
      : null;
    if (input.id && !existing) throw new NotFoundException("Private model provider not found.");
    const apiKey = input.apiKey?.trim() ?? "";
    if (!existing && !apiKey) {
      throw new BadRequestException("API key is required when creating a private model provider.");
    }
    const contextWindow = input.contextWindow ?? 128000;
    const model = {
      id: input.defaultModel,
      label: input.defaultModel,
      contextWindow,
      embeddingModel: input.embeddingModel?.trim() || undefined,
      embeddingTokenPrice: 0
    };
    const data = {
      scope: ModelProviderScope.USER_PRIVATE,
      ownerId: userId,
      kind: this.toPrismaProviderKind(input.kind),
      name: input.name,
      baseUrl,
      apiKeyCiphertext: apiKey ? this.sealApiKey(apiKey) : existing?.apiKeyCiphertext ?? "",
      models: [model],
      enabled: true,
      promptTokenPrice: 0,
      completionTokenPrice: 0,
      contextWindow
    };
    const provider = existing
      ? await this.prisma.modelProviderConfig.update({ where: { id: existing.id }, data })
      : await this.prisma.modelProviderConfig.create({ data });
    return this.toPublicProvider(provider);
  }

  async deletePrivateProvider(userId: string, id: string): Promise<{ ok: true }> {
    const deleted = await this.prisma.modelProviderConfig.deleteMany({
      where: { id, scope: ModelProviderScope.USER_PRIVATE, ownerId: userId }
    });
    if (!deleted.count) throw new NotFoundException("Private model provider not found.");
    return { ok: true };
  }

  async testPrivateProvider(userId: string, input: PrivateProviderInput): Promise<{ ok: true; message: string }> {
    await this.userAccess.ensureUser(userId);
    if (input.kind.toLowerCase() === "ollama") {
      throw new BadRequestException("Private model providers must use a cloud API reachable by the server.");
    }
    const baseUrl = await this.privateProviderBaseUrl(input.baseUrl);
    const existing = input.id
      ? await this.prisma.modelProviderConfig.findFirst({
        where: { id: input.id, scope: ModelProviderScope.USER_PRIVATE, ownerId: userId }
      })
      : null;
    if (input.id && !existing) throw new NotFoundException("Private model provider not found.");
    const apiKey = input.apiKey?.trim() || (existing ? this.unsealApiKey(existing.apiKeyCiphertext) : "");
    if (!apiKey) throw new BadRequestException("API key is required for testing.");
    const contextWindow = input.contextWindow ?? 128000;
    const provider = {
      ...(existing ?? {}),
      id: existing?.id ?? "private-provider-test",
      scope: ModelProviderScope.USER_PRIVATE,
      ownerId: userId,
      kind: this.toPrismaProviderKind(input.kind),
      name: input.name,
      baseUrl,
      apiKeyCiphertext: apiKey ? this.sealApiKey(apiKey) : "",
      models: [{
        id: input.defaultModel,
        label: input.defaultModel,
        contextWindow,
        embeddingModel: input.embeddingModel?.trim() || this.providerEmbeddingModel(existing) || undefined,
        embeddingTokenPrice: 0
      }],
      enabled: true,
      promptTokenPrice: 0,
      completionTokenPrice: 0,
      contextWindow,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date()
    } as ModelProviderConfig;
    await this.callProvider(provider, input.defaultModel, [
      { role: "system", content: "Reply with OK." },
      { role: "user", content: "Connection test" }
    ], 0);
    return { ok: true, message: "Cloud connection verified. Credentials remain private to your account." };
  }

  async assertAgentProviderAccess(
    userId: string,
    providerId: string | null | undefined,
    visibility: string,
    model?: string | null
  ): Promise<void> {
    if (!providerId) return;
    const provider = await this.getEnabledProvider(providerId, userId, true);
    if (visibility.toLowerCase() !== "private" && provider.scope !== ModelProviderScope.PLATFORM) {
      throw new BadRequestException("Public and unlisted agents can only use platform model providers.");
    }
    if (model) this.assertConfiguredChatModel(provider, model);
  }

  async cloudChat(userId: string, input: CloudChatRequest & { requestKey?: string }): Promise<CloudChatResponse> {
    const provider = await this.getEnabledProvider(input.providerId!, userId, true);
    const model = this.assertConfiguredChatModel(provider, input.model);
    const messages = this.buildSkillMessages(input.skill, input.messages);
    const estimatedPrompt = this.estimateTokens(messages.map((message) => message.content).join("\n"));
    const budget = this.providerCallBudget(provider, model, messages, 1200);
    const reservedTokens = this.calculateCharge(provider, budget.promptTokenLimit, budget.completionTokenLimit);
    const requestKey = this.requestKey("cloud-chat", userId, input.requestKey);
    const claim = await this.reserveModelCall({
      requestKey,
      requestHash: this.requestHash({ userId, providerId: provider.id, model, messages }),
      purpose: ModelCallPurpose.CLOUD_CHAT,
      userId,
      providerId: provider.id,
      model,
      reservedTokens,
      ...budget
    });
    if (claim.state === "pending") {
      throw new ConflictException("This cloud model request is already in progress; it was not sent again.");
    }
    if (claim.state === "settled") {
      return this.replayCompletionReservation(claim.reservation, provider.name, userId);
    }

    const started = Date.now();
    let result: ProviderCallResult;
    try {
      result = await this.callProvider(provider, model, messages, 0.7, budget.completionTokenLimit);
    } catch (error) {
      await this.failModelCall(claim.reservation, error, estimatedPrompt);
      const elapsed = Date.now() - started;
      throw new BadRequestException(`Cloud model call failed after ${elapsed}ms: ${error instanceof Error ? error.message : String(error)}`);
    }
    const chargedTokens = this.calculateCharge(provider, result.promptTokens, result.completionTokens);
    const response: StoredCompletionResponse = {
      ...result,
      modelLabel: `${provider.name} / ${model}`
    };
    const settled = await this.settleModelCall(claim.reservation, {
      result,
      modelCharge: chargedTokens,
      serviceFee: 0,
      response: response as unknown as Prisma.InputJsonValue,
      modelNote: `Cloud chat via ${provider.name}`
    });
    return { ...response, chargedTokens: settled.reservation.chargedTokens, balanceAfter: settled.balanceAfter };
  }

  async agentCompletion(userId: string, input: {
    providerId: string;
    model: string;
    system: string;
    prompt: string;
    temperature?: number;
    agentId: string;
    runId: string;
    maxCompletionTokens?: number;
  }): Promise<AgentCompletionResult> {
    const billingAgent = await this.prisma.agent.findUnique({
      where: { id: input.agentId },
      select: { ownerId: true, serviceFee: true }
    });
    if (!billingAgent) throw new NotFoundException("Agent not found for model billing.");
    const serviceFee = billingAgent.ownerId === userId ? 0 : billingAgent.serviceFee;
    const replay = await this.prisma.modelCallLog.findUnique({
      where: { agentRunId: input.runId },
      include: { provider: { select: { name: true } } }
    });
    if (replay?.success && replay.responseContent !== null) {
      return this.replayAgentCompletion(replay, replay.provider?.name, await this.currentBalance(userId));
    }
    const provider = await this.getEnabledProvider(input.providerId, userId, true);
    const model = this.assertConfiguredChatModel(provider, input.model);
    const messages = [
      { role: "system", content: input.system },
      { role: "user", content: input.prompt }
    ];
    const estimatedPrompt = this.estimateTokens(`${input.system}\n${input.prompt}`);
    const desiredCompletionTokens = Math.min(
      1600,
      Math.max(1, Math.floor(input.maxCompletionTokens ?? 1600))
    );
    const budget = this.providerCallBudget(provider, model, messages, desiredCompletionTokens);
    const reservedTokens = this.calculateCharge(provider, budget.promptTokenLimit, budget.completionTokenLimit) + serviceFee;
    const claim = await this.reserveModelCall({
      requestKey: `agent-run:${input.runId}:completion`,
      requestHash: this.requestHash({ userId, ...input, model }),
      purpose: ModelCallPurpose.AGENT_COMPLETION,
      userId,
      providerId: provider.id,
      model,
      reservedTokens,
      serviceFee,
      beneficiaryUserId: serviceFee > 0 ? billingAgent.ownerId : null,
      ...budget
    });
    if (claim.state === "pending") {
      throw new ConflictException("This agent run already has a pending model call; the provider was not called again.");
    }
    if (claim.state === "settled") {
      return this.replayCompletionReservation(claim.reservation, provider.name, userId);
    }

    let result: ProviderCallResult;
    try {
      result = await this.callProvider(provider, model, messages, input.temperature ?? 0.7, budget.completionTokenLimit);
    } catch (error) {
      await this.failModelCall(claim.reservation, error, estimatedPrompt);
      throw error;
    }
    const modelCharge = this.calculateCharge(provider, result.promptTokens, result.completionTokens);
    const response: StoredCompletionResponse = {
      ...result,
      modelLabel: `${provider.name} / ${model}`
    };
    const settled = await this.settleModelCall(claim.reservation, {
      result,
      modelCharge,
      serviceFee,
      beneficiaryUserId: serviceFee > 0 ? billingAgent.ownerId : undefined,
      agentRunId: input.runId,
      agentId: input.agentId,
      response: response as unknown as Prisma.InputJsonValue,
      modelNote: `Agent run via ${provider.name}`
    });
    return {
      ...response,
      chargedTokens: settled.reservation.chargedTokens,
      balanceAfter: settled.balanceAfter
    };
  }

  async agentEmbedding(agentId: string, text: string, payerUserId?: string, stableRequestKey?: string): Promise<EmbeddingResult> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, ownerId: true, modelProviderId: true }
    });
    if (!agent?.modelProviderId) return this.fallbackEmbedding(text);
    const provider = await this.getEnabledProvider(agent.modelProviderId, agent.ownerId, true).catch(() => null);
    const model = this.providerEmbeddingModel(provider);
    if (!provider || !model) return this.fallbackEmbedding(text);
    const userId = payerUserId || agent.ownerId;
    const promptTokens = this.estimateTokens(text);
    const promptTokenLimit = Math.min(
      Math.max(1, provider.contextWindow),
      Math.max(promptTokens, Buffer.byteLength(text, "utf8") + 16)
    );
    const reservedTokens = this.calculateEmbeddingCharge(provider, promptTokenLimit);
    const claim = await this.reserveModelCall({
      requestKey: this.requestKey("embedding", userId, stableRequestKey),
      requestHash: this.requestHash({ agentId, userId, providerId: provider.id, model, text }),
      purpose: ModelCallPurpose.EMBEDDING,
      userId,
      providerId: provider.id,
      model,
      reservedTokens,
      promptTokenLimit,
      completionTokenLimit: 0
    });
    if (claim.state === "pending") {
      throw new ConflictException("This embedding request is already in progress; it was not sent again.");
    }
    if (claim.state === "settled") {
      return this.reservationResponse<StoredEmbeddingResponse>(claim.reservation);
    }

    let vector: number[];
    try {
      vector = await this.callEmbeddingProvider(provider, model, text);
    } catch (error) {
      await this.failModelCall(claim.reservation, error, promptTokens);
      return this.fallbackEmbedding(text);
    }
    const chargedTokens = Math.min(this.calculateEmbeddingCharge(provider, promptTokens), reservedTokens);
    const response: StoredEmbeddingResponse = {
      vector,
      model,
      providerId: provider.id,
      fallback: false,
      promptTokens,
      chargedTokens
    };
    await this.settleModelCall(claim.reservation, {
      result: { content: "", promptTokens, completionTokens: 0 },
      modelCharge: chargedTokens,
      serviceFee: 0,
      agentId,
      response: response as unknown as Prisma.InputJsonValue,
      modelNote: `Agent embedding via ${provider.name}`
    });
    return response;
  }

  private async reserveModelCall(input: {
    requestKey: string;
    requestHash: string;
    purpose: ModelCallPurpose;
    userId: string;
    providerId: string;
    model: string;
    reservedTokens: number;
    promptTokenLimit: number;
    completionTokenLimit: number;
    serviceFee?: number;
    beneficiaryUserId?: string | null;
  }): Promise<ReservationClaim> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        let existing = await tx.modelCallReservation.findUnique({ where: { requestKey: input.requestKey } });
        if (existing) {
          this.assertReservationMatches(existing, input.requestHash);
          if (existing.status === ModelCallReservationStatus.SETTLED) return { state: "settled", reservation: existing };
          if (existing.status === ModelCallReservationStatus.PENDING) {
            const staleBefore = new Date(Date.now() - this.pendingReservationStaleMs());
            if (existing.updatedAt > staleBefore) return { state: "pending", reservation: existing };
            const expired = await tx.modelCallReservation.updateMany({
              where: {
                id: existing.id,
                attempt: existing.attempt,
                status: ModelCallReservationStatus.PENDING,
                updatedAt: { lte: staleBefore }
              },
              data: {
                status: ModelCallReservationStatus.FAILED,
                chargedTokens: 0,
                error: "Recovered a stale model-call reservation after its execution lease expired.",
                settledAt: new Date()
              }
            });
            if (!expired.count) {
              const current = await tx.modelCallReservation.findUniqueOrThrow({ where: { id: existing.id } });
              return this.classifyReservation(current);
            }
            await this.wallet.releaseTokenReservationInTransaction(tx, existing.userId, existing.reservedTokens);
            existing = await tx.modelCallReservation.findUniqueOrThrow({ where: { id: existing.id } });
          }
          const claimed = await tx.modelCallReservation.updateMany({
            where: {
              id: existing.id,
              attempt: existing.attempt,
              status: ModelCallReservationStatus.FAILED
            },
            data: {
              status: ModelCallReservationStatus.PENDING,
              attempt: { increment: 1 },
              reservedTokens: input.reservedTokens,
              chargedTokens: 0,
              promptTokenLimit: input.promptTokenLimit,
              completionTokenLimit: input.completionTokenLimit,
              promptTokens: 0,
              completionTokens: 0,
              serviceFee: input.serviceFee ?? 0,
              beneficiaryUserId: input.beneficiaryUserId ?? null,
              response: Prisma.DbNull,
              error: null,
              settledAt: null
            }
          });
          if (!claimed.count) {
            const current = await tx.modelCallReservation.findUniqueOrThrow({ where: { id: existing.id } });
            return this.classifyReservation(current);
          }
          await this.wallet.reserveTokensInTransaction(tx, input.userId, input.reservedTokens);
          const reservation = await tx.modelCallReservation.findUniqueOrThrow({ where: { id: existing.id } });
          return { state: "acquired", reservation };
        }
        await this.wallet.reserveTokensInTransaction(tx, input.userId, input.reservedTokens);
        const reservation = await tx.modelCallReservation.create({
          data: {
            requestKey: input.requestKey,
            requestHash: input.requestHash,
            purpose: input.purpose,
            userId: input.userId,
            providerId: input.providerId,
            model: input.model,
            reservedTokens: input.reservedTokens,
            promptTokenLimit: input.promptTokenLimit,
            completionTokenLimit: input.completionTokenLimit,
            serviceFee: input.serviceFee ?? 0,
            beneficiaryUserId: input.beneficiaryUserId ?? null
          }
        });
        return { state: "acquired", reservation };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.prisma.modelCallReservation.findUnique({ where: { requestKey: input.requestKey } });
        if (existing) {
          this.assertReservationMatches(existing, input.requestHash);
          return this.classifyReservation(existing);
        }
      }
      throw error;
    }
  }

  private async settleModelCall(claim: Pick<ModelCallReservation, "id" | "attempt">, input: {
    result: ProviderCallResult;
    modelCharge: number;
    serviceFee: number;
    beneficiaryUserId?: string;
    agentRunId?: string;
    agentId?: string;
    response: Prisma.InputJsonValue;
    modelNote: string;
  }): Promise<{ reservation: ModelCallReservation; balanceAfter: number }> {
    this.assertProviderUsage(input.result);
    if (!Number.isInteger(input.modelCharge) || input.modelCharge < 0) {
      throw new BadRequestException("Model charge must be a non-negative integer.");
    }
    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.modelCallReservation.findUniqueOrThrow({ where: { id: claim.id } });
      if (reservation.attempt !== claim.attempt) {
        throw new ConflictException("A newer attempt owns this model-call reservation.");
      }
      if (reservation.status === ModelCallReservationStatus.SETTLED) {
        return { reservation, balanceAfter: await this.currentBalance(reservation.userId, tx) };
      }
      if (reservation.status !== ModelCallReservationStatus.PENDING) {
        throw new ConflictException("Model call reservation is no longer pending and cannot be settled.");
      }
      if (input.serviceFee !== reservation.serviceFee) {
        throw new BadRequestException("Model call service fee changed after it was reserved.");
      }
      if ((input.beneficiaryUserId ?? null) !== (reservation.beneficiaryUserId ?? null)) {
        throw new BadRequestException("Model call beneficiary changed after it was reserved.");
      }
      const maximumModelCharge = Math.max(0, reservation.reservedTokens - input.serviceFee);
      // The provider may ignore max_tokens or report malformed usage. Never
      // charge more than the amount quoted and held before the external call.
      const modelCharge = Math.min(input.modelCharge, maximumModelCharge);
      const chargedTokens = modelCharge + input.serviceFee;
      const metadata = {
        reservationId: reservation.id,
        requestKey: reservation.requestKey,
        attempt: reservation.attempt,
        providerId: reservation.providerId,
        model: reservation.model,
        ...(modelCharge !== input.modelCharge ? { providerReportedModelCharge: input.modelCharge, chargeCapped: true } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.agentRunId ? { runId: input.agentRunId } : {})
      } as Prisma.InputJsonValue;
      const changed = await tx.modelCallReservation.updateMany({
        where: {
          id: reservation.id,
          attempt: claim.attempt,
          status: ModelCallReservationStatus.PENDING
        },
        data: {
          status: ModelCallReservationStatus.SETTLED,
          chargedTokens,
          promptTokens: input.result.promptTokens,
          completionTokens: input.result.completionTokens,
          response: input.response,
          error: null,
          settledAt: new Date()
        }
      });
      if (!changed.count) {
        const current = await tx.modelCallReservation.findUniqueOrThrow({ where: { id: reservation.id } });
        if (current.status === ModelCallReservationStatus.SETTLED) {
          return { reservation: current, balanceAfter: await this.currentBalance(current.userId, tx) };
        }
        throw new ConflictException("Model call reservation changed while it was being settled.");
      }
      const charges: WalletCharge[] = [{
        amount: modelCharge,
        kind: reservation.purpose === ModelCallPurpose.CLOUD_CHAT || reservation.purpose === ModelCallPurpose.DISTILLATION
          ? TokenTransactionKind.CLOUD_MODEL_USAGE
          : TokenTransactionKind.AGENT_MODEL_USAGE,
        note: input.modelNote,
        metadata
      }];
      if (input.serviceFee > 0) {
        charges.push({
          amount: input.serviceFee,
          kind: TokenTransactionKind.AGENT_SERVICE_FEE,
          note: `Service fee for agent ${input.agentId ?? "unknown"}`,
          metadata
        });
      }
      const balanceAfter = await this.wallet.settleTokenReservationInTransaction(
        tx,
        reservation.userId,
        reservation.reservedTokens,
        charges
      );
      if (input.serviceFee > 0 && reservation.beneficiaryUserId && reservation.beneficiaryUserId !== reservation.userId) {
          await this.wallet.creditTokensInTransaction(
            tx,
            reservation.beneficiaryUserId,
            input.serviceFee,
            `Service earning from agent ${input.agentId ?? "unknown"}`,
            { ...(metadata as Record<string, unknown>), payerUserId: reservation.userId } as Prisma.InputJsonValue,
            TokenTransactionKind.AGENT_SERVICE_EARNING
          );
      }
      await tx.modelCallLog.create({
        data: {
          agentRunId: input.agentRunId,
          userId: reservation.userId,
          providerId: reservation.providerId,
          model: reservation.model,
          promptTokens: input.result.promptTokens,
          completionTokens: input.result.completionTokens,
          chargedTokens,
          serviceFee: input.serviceFee,
          beneficiaryUserId: input.serviceFee > 0 ? reservation.beneficiaryUserId : null,
          success: true,
          responseContent: input.result.content || null
        }
      });
      const settled = await tx.modelCallReservation.findUniqueOrThrow({ where: { id: reservation.id } });
      return { reservation: settled, balanceAfter };
    });
  }

  private async failModelCall(
    claim: Pick<ModelCallReservation, "id" | "attempt">,
    error: unknown,
    promptTokens: number
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.prisma.$transaction(async (tx) => {
      const reservation = await tx.modelCallReservation.findUnique({ where: { id: claim.id } });
      if (
        !reservation
        || reservation.attempt !== claim.attempt
        || reservation.status !== ModelCallReservationStatus.PENDING
      ) return;
      const changed = await tx.modelCallReservation.updateMany({
        where: {
          id: reservation.id,
          attempt: claim.attempt,
          status: ModelCallReservationStatus.PENDING
        },
        data: {
          status: ModelCallReservationStatus.FAILED,
          chargedTokens: 0,
          promptTokens,
          completionTokens: 0,
          error: message.slice(0, 4000),
          settledAt: new Date()
        }
      });
      if (!changed.count) return;
      await this.wallet.releaseTokenReservationInTransaction(tx, reservation.userId, reservation.reservedTokens);
      await tx.modelCallLog.create({
        data: {
          userId: reservation.userId,
          providerId: reservation.providerId,
          model: reservation.model,
          promptTokens,
          completionTokens: 0,
          chargedTokens: 0,
          serviceFee: 0,
          success: false,
          error: message.slice(0, 4000)
        }
      });
    });
  }

  private classifyReservation(reservation: ModelCallReservation): ReservationClaim {
    if (reservation.status === ModelCallReservationStatus.SETTLED) return { state: "settled", reservation };
    if (reservation.status === ModelCallReservationStatus.PENDING) return { state: "pending", reservation };
    throw new ConflictException("The previous model attempt failed while another retry was claiming it.");
  }

  private assertReservationMatches(reservation: ModelCallReservation, requestHash: string): void {
    if (reservation.requestHash !== requestHash) {
      throw new BadRequestException("The model request key was already used for different input.");
    }
  }

  private reservationResponse<T>(reservation: ModelCallReservation): T {
    if (!reservation.response || typeof reservation.response !== "object" || Array.isArray(reservation.response)) {
      throw new ConflictException("The settled model request has no replayable response.");
    }
    return reservation.response as unknown as T;
  }

  private async replayCompletionReservation(
    reservation: ModelCallReservation,
    providerName: string,
    userId: string
  ): Promise<AgentCompletionResult> {
    const response = this.reservationResponse<StoredCompletionResponse>(reservation);
    return {
      ...response,
      chargedTokens: reservation.chargedTokens,
      balanceAfter: await this.currentBalance(userId),
      modelLabel: response.modelLabel || `${providerName} / ${reservation.model}`
    };
  }

  private replayAgentCompletion(log: ModelCallLog, providerName: string | undefined, balanceAfter: number): AgentCompletionResult {
    return {
      content: log.responseContent ?? "",
      promptTokens: log.promptTokens,
      completionTokens: log.completionTokens,
      chargedTokens: log.chargedTokens,
      balanceAfter,
      modelLabel: `${providerName ?? "Model"} / ${log.model}`
    };
  }

  private async currentBalance(userId: string, tx: Prisma.TransactionClient | PrismaService = this.prisma): Promise<number> {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { tokenBalance: true } });
    return user.tokenBalance;
  }

  async distill(userId: string, input: DistillRequest & { requestKey?: string }): Promise<DistillResponse> {
    return this.distillWithCleanPrompt(userId, input);
  }

  buildSkillMessages(skill: SkillDraft, messages: Array<{ role: string; content: string }>) {
    return this.buildCleanSkillMessages(skill, messages);
  }

  heuristicDraft(input: DistillRequest): SkillDraft {
    return this.heuristicDraftClean(input);
  }

  private parseDraftOrFallback(content: string, input: DistillRequest): SkillDraft {
    return this.parseDraftOrFallbackClean(content, input);
  }

  private async distillWithCleanPrompt(userId: string, input: DistillRequest & { requestKey?: string }): Promise<DistillResponse> {
    if (!input.providerId || !input.model) {
      return { draft: this.heuristicDraftClean(input) };
    }

    const provider = await this.getEnabledProvider(input.providerId, userId, true);
    const model = this.assertConfiguredChatModel(provider, input.model);
    const selected = input.messages.filter((message) => message.selected);
    const transcript = selected
      .slice(0, 400)
      .map((message) => `${message.timestamp ? `[${message.timestamp}] ` : ""}${message.speaker}: ${message.content}`)
      .join("\n");
    const system = [
      "你是 Chaq 的 Skill 蒸馏器。",
      "只输出 JSON，不要输出原始长聊天记录，不要复述隐私细节。",
      "目标是把聊天资料整理成一个可聊天、可升级为 Agent 的虚拟人格 Skill。"
    ].join("\n");
    const prompt = [
      "请把下面的聊天资料蒸馏为一个可聊天的虚拟 Skill。",
      "JSON 字段必须是 name, description, persona, tone, knowledge, boundaries, examples, tags。",
      "examples 必须是 { user, assistant } 数组，tags 必须是短标签数组。",
      input.preferredName ? `用户偏好的 Skill 名称：${input.preferredName}` : "",
      "禁止复制超过 80 个连续字符的原文。请提炼表达习惯、关系背景、常见关注点和边界。",
      "聊天资料：",
      transcript
    ].filter(Boolean).join("\n\n");

    const messages = [
      { role: "system", content: system },
      { role: "user", content: prompt }
    ];
    const estimatedPrompt = this.estimateTokens(system + prompt);
    const budget = this.providerCallBudget(provider, model, messages, 1200);
    const reservedTokens = this.calculateCharge(provider, budget.promptTokenLimit, budget.completionTokenLimit);
    const claim = await this.reserveModelCall({
      requestKey: this.requestKey("distillation", userId, input.requestKey),
      requestHash: this.requestHash({ userId, providerId: provider.id, model, sourceKind: input.sourceKind, messages }),
      purpose: ModelCallPurpose.DISTILLATION,
      userId,
      providerId: provider.id,
      model,
      reservedTokens,
      ...budget
    });
    if (claim.state === "pending") {
      throw new ConflictException("This distillation request is already in progress; it was not sent again.");
    }
    if (claim.state === "settled") {
      const replay = this.reservationResponse<StoredCompletionResponse>(claim.reservation);
      return {
        draft: this.parseDraftOrFallbackClean(replay.content, input),
        promptTokens: replay.promptTokens,
        completionTokens: replay.completionTokens,
        balanceAfter: await this.currentBalance(userId)
      };
    }

    let result: ProviderCallResult;
    try {
      result = await this.callProvider(provider, model, messages, 0.7, budget.completionTokenLimit);
    } catch (error) {
      await this.failModelCall(claim.reservation, error, estimatedPrompt);
      throw error;
    }
    const chargedTokens = this.calculateCharge(provider, result.promptTokens, result.completionTokens);
    const response: StoredCompletionResponse = {
      ...result,
      modelLabel: `${provider.name} / ${model}`
    };
    const settled = await this.settleModelCall(claim.reservation, {
      result,
      modelCharge: chargedTokens,
      serviceFee: 0,
      response: response as unknown as Prisma.InputJsonValue,
      modelNote: `Distillation via ${provider.name}`
    });

    return {
      draft: this.parseDraftOrFallbackClean(result.content, input),
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      balanceAfter: settled.balanceAfter
    };
  }

  private buildCleanSkillMessages(skill: SkillDraft, messages: Array<{ role: string; content: string }>) {
    const system = [
      `你正在扮演 Chaq Skill：${skill.name}`,
      `简介：${skill.description}`,
      `人格：${skill.persona}`,
      `语气：${skill.tone}`,
      skill.knowledge ? `知识摘要：${skill.knowledge}` : "",
      skill.boundaries ? `边界：${skill.boundaries}` : "",
      "请保持角色一致，不要声称你看到了未提供的原始聊天记录。"
    ].filter(Boolean).join("\n");

    return [
      { role: "system", content: system },
      ...messages.slice(-30).map((message) => ({
        role: message.role,
        content: message.content
      }))
    ];
  }

  private heuristicDraftClean(input: DistillRequest): SkillDraft {
    const selected = input.messages.filter((message) => message.selected);
    const speakerCounts = new Map<string, number>();
    const snippets: string[] = [];
    for (const message of selected.slice(0, 200)) {
      speakerCounts.set(message.speaker, (speakerCounts.get(message.speaker) ?? 0) + 1);
      if (snippets.length < 12 && message.content.length > 8) {
        snippets.push(`${message.speaker}: ${message.content.slice(0, 80)}`);
      }
    }
    const topSpeakers = [...speakerCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const speakerSummary = topSpeakers.map(([speaker, count]) => `${speaker}(${count})`).join("、") || "未识别";
    const mainName = input.preferredName || topSpeakers[0]?.[0] || "新的 Skill";
    const sourceLabel = input.sourceKind.toUpperCase();
    return {
      name: mainName,
      avatarUrl: null,
      description: `从 ${sourceLabel} 导入资料蒸馏出的聊天 Skill。`,
      persona: `这个 Skill 基于 ${selected.length} 条已选择消息整理而成。重点保留主要说话人的表达习惯、关系背景和常见关注点。`,
      tone: `语气参考高频说话人：${speakerSummary}。回复应自然、克制，不直接复述原始材料。`,
      knowledge: snippets.join("\n"),
      boundaries: "不要泄露原始导入资料中的隐私信息；不确定的事实要说明不确定；避免冒充真实本人做承诺。",
      examples: [
        {
          user: "今天有点不知道该怎么开始。",
          assistant: "那我们先从最轻的一步开始。你把现在最占脑子的那件事说出来，我陪你一起拆。"
        }
      ],
      tags: [input.sourceKind, "蒸馏", "私有"]
    };
  }

  private parseDraftOrFallbackClean(content: string, input: DistillRequest): SkillDraft {
    const fallback = this.heuristicDraftClean(input);
    try {
      const jsonText = content.match(/\{[\s\S]*\}/)?.[0] ?? content;
      const parsed = JSON.parse(jsonText) as Partial<SkillDraft>;
      return {
        ...fallback,
        ...parsed,
        name: parsed.name || fallback.name,
        description: parsed.description || fallback.description,
        persona: parsed.persona || fallback.persona,
        tone: parsed.tone || fallback.tone,
        knowledge: parsed.knowledge || fallback.knowledge,
        boundaries: parsed.boundaries || fallback.boundaries,
        examples: Array.isArray(parsed.examples) ? parsed.examples.slice(0, 8) : fallback.examples,
        tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 8) : fallback.tags
      };
    } catch {
      return {
        ...fallback,
        knowledge: `${fallback.knowledge}\n\n模型返回摘要：${content.slice(0, 1500)}`
      };
    }
  }

  private async getEnabledProvider(providerId: string, userId: string, allowPrivate: boolean): Promise<ModelProviderConfig> {
    const provider = await this.prisma.modelProviderConfig.findUnique({ where: { id: providerId } });
    if (!provider || !provider.enabled) {
      throw new NotFoundException("Enabled cloud model provider not found.");
    }
    if (provider.scope === ModelProviderScope.USER_PRIVATE && (!allowPrivate || provider.ownerId !== userId)) {
      throw new NotFoundException("Enabled cloud model provider not found.");
    }
    return provider;
  }

  private assertConfiguredChatModel(provider: ModelProviderConfig, requestedModel: string): string {
    const requested = requestedModel.trim();
    const models = Array.isArray(provider.models) ? provider.models as Array<Record<string, unknown>> : [];
    const configured = models.find((model) => typeof model.id === "string" && model.id === requested);
    if (!configured) {
      throw new BadRequestException(`Model ${requested || "(empty)"} is not enabled for provider ${provider.name}.`);
    }
    return requested;
  }

  private async privateProviderBaseUrl(value: string): Promise<string> {
    try {
      const url = await assertOutboundUrl(value.trim(), { allowHttp: false });
      if (url.username || url.password) {
        throw new Error("Provider base URL cannot contain embedded credentials.");
      }
      if (url.search || url.hash) {
        throw new Error("Provider base URL cannot contain a query string or fragment.");
      }
      return url.toString().replace(/\/$/, "");
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  private platformProviderBaseUrl(value: string): string {
    try {
      const url = new URL(value.trim());
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("Provider base URL must use HTTP or HTTPS.");
      }
      if (url.username || url.password) {
        throw new Error("Provider base URL cannot contain embedded credentials.");
      }
      if (url.search || url.hash) {
        throw new Error("Provider base URL cannot contain a query string or fragment.");
      }
      return url.toString().replace(/\/$/, "");
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  private async providerFetch(provider: ModelProviderConfig, value: string, init: RequestInit): Promise<Response> {
    if (provider.scope === ModelProviderScope.USER_PRIVATE) {
      return safeFetch(value, init, { allowHttp: false });
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException("Provider URL is invalid.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new BadRequestException("Provider URL must use HTTP or HTTPS.");
    }
    const response = await globalThis.fetch(url, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Provider redirects are not allowed.");
    }
    return response;
  }

  private async callProvider(
    provider: ModelProviderConfig,
    model: string,
    messages: Array<{ role: string; content: string }>,
    temperature = 0.7,
    maxCompletionTokens = 1200
  ): Promise<ProviderCallResult> {
    model = this.assertConfiguredChatModel(provider, model);
    const apiKey = this.unsealApiKey(provider.apiKeyCiphertext);
    if (provider.kind !== ProviderKind.OLLAMA && (!apiKey || apiKey === "replace-me")) {
      throw new BadRequestException("Provider API key is not configured.");
    }

    if (provider.kind === ProviderKind.ANTHROPIC) {
      return this.callAnthropic(provider, apiKey, model, messages, maxCompletionTokens);
    }
    if (provider.kind === ProviderKind.GOOGLE) {
      return this.callGoogle(provider, apiKey, model, messages, maxCompletionTokens);
    }
    if (provider.kind === ProviderKind.OLLAMA) {
      return this.callOpenAICompatible(provider, "", model, messages, temperature, maxCompletionTokens);
    }
    return this.callOpenAICompatible(provider, apiKey, model, messages, temperature, maxCompletionTokens);
  }

  private async callOpenAICompatible(
    provider: ModelProviderConfig,
    apiKey: string,
    model: string,
    messages: Array<{ role: string; content: string }>,
    temperature = 0.7,
    maxCompletionTokens = 1200
  ): Promise<ProviderCallResult> {
    const response = await this.providerFetch(provider, `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(this.modelRequestTimeoutMs()),
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxCompletionTokens
      })
    });
    const data = await readResponseJsonLimited<any>(response, maxProviderResponseBytes);
    if (!response.ok) {
      throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
    }
    const content = data?.choices?.[0]?.message?.content ?? "";
    return {
      content,
      promptTokens: this.providerUsageTokens(data?.usage?.prompt_tokens, this.estimateTokens(JSON.stringify(messages))),
      completionTokens: this.providerUsageTokens(data?.usage?.completion_tokens, this.estimateTokens(content))
    };
  }

  private async callAnthropic(
    provider: ModelProviderConfig,
    apiKey: string,
    model: string,
    messages: Array<{ role: string; content: string }>,
    maxCompletionTokens = 1200
  ): Promise<ProviderCallResult> {
    const system = messages.find((message) => message.role === "system")?.content;
    const conversation = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content
      }));
    const response = await this.providerFetch(provider, `${provider.baseUrl.replace(/\/$/, "")}/messages`, {
      method: "POST",
      signal: AbortSignal.timeout(this.modelRequestTimeoutMs()),
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        system,
        messages: conversation,
        max_tokens: maxCompletionTokens
      })
    });
    const data = await readResponseJsonLimited<any>(response, maxProviderResponseBytes);
    if (!response.ok) {
      throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
    }
    const content = data?.content?.map((part: any) => part.text ?? "").join("") ?? "";
    return {
      content,
      promptTokens: this.providerUsageTokens(data?.usage?.input_tokens, this.estimateTokens(JSON.stringify(messages))),
      completionTokens: this.providerUsageTokens(data?.usage?.output_tokens, this.estimateTokens(content))
    };
  }

  private async callGoogle(
    provider: ModelProviderConfig,
    apiKey: string,
    model: string,
    messages: Array<{ role: string; content: string }>,
    maxCompletionTokens = 1200
  ): Promise<ProviderCallResult> {
    const contents = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }]
      }));
    const systemInstruction = messages.find((message) => message.role === "system")?.content;
    const response = await this.providerFetch(provider, `${provider.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      signal: AbortSignal.timeout(this.modelRequestTimeoutMs()),
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents,
        systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
        generationConfig: { maxOutputTokens: maxCompletionTokens }
      })
    });
    const data = await readResponseJsonLimited<any>(response, maxProviderResponseBytes);
    if (!response.ok) {
      throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
    }
    const content = data?.candidates?.[0]?.content?.parts?.map((part: any) => part.text ?? "").join("") ?? "";
    return {
      content,
      promptTokens: this.providerUsageTokens(data?.usageMetadata?.promptTokenCount, this.estimateTokens(JSON.stringify(messages))),
      completionTokens: this.providerUsageTokens(data?.usageMetadata?.candidatesTokenCount, this.estimateTokens(content))
    };
  }

  private async callEmbeddingProvider(provider: ModelProviderConfig, model: string, text: string): Promise<number[]> {
    const apiKey = this.unsealApiKey(provider.apiKeyCiphertext);
    if (provider.kind === ProviderKind.GOOGLE) {
      const response = await this.providerFetch(provider, `${provider.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:embedContent`, {
        method: "POST",
        signal: AbortSignal.timeout(this.modelRequestTimeoutMs()),
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({ content: { parts: [{ text }] } })
      });
      const data = await readResponseJsonLimited<any>(response, maxProviderResponseBytes);
      if (!response.ok) throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
      return this.normalizeEmbedding(data?.embedding?.values);
    }
    if (provider.kind === ProviderKind.ANTHROPIC) {
      throw new Error("Anthropic provider does not expose an embedding endpoint in Chaq yet.");
    }
    const response = await this.providerFetch(provider, `${provider.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      signal: AbortSignal.timeout(this.modelRequestTimeoutMs()),
      headers: {
        "content-type": "application/json",
        ...(apiKey && apiKey !== "replace-me" ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({ model, input: text })
    });
    const data = await readResponseJsonLimited<any>(response, maxProviderResponseBytes);
    if (!response.ok) throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
    return this.normalizeEmbedding(data?.data?.[0]?.embedding);
  }

  private normalizeEmbedding(value: unknown): number[] {
    if (!Array.isArray(value)) throw new Error("Embedding response did not contain a vector.");
    const vector = value.map(Number).filter((item) => Number.isFinite(item));
    if (!vector.length) throw new Error("Embedding response vector was empty.");
    const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
    return norm ? vector.map((item) => Number((item / norm).toFixed(8))) : vector;
  }

  private fallbackEmbedding(text: string): EmbeddingResult {
    return {
      vector: embedText(text),
      model: "chaq-hash-v1",
      fallback: true,
      promptTokens: this.estimateTokens(text),
      chargedTokens: 0
    };
  }

  private withEmbeddingMetadata(
    models: Array<{ id: string; label: string; contextWindow: number }>,
    embeddingModel?: string,
    embeddingTokenPrice = 0
  ): Prisma.InputJsonValue {
    const cleanedEmbeddingModel = embeddingModel?.trim();
    return models.map((model, index) => ({
      ...model,
      ...(index === 0 && cleanedEmbeddingModel ? { embeddingModel: cleanedEmbeddingModel } : {}),
      ...(index === 0 && embeddingTokenPrice > 0 ? { embeddingTokenPrice } : {})
    })) as Prisma.InputJsonValue;
  }

  private providerEmbeddingModel(provider: Pick<ModelProviderConfig, "models"> | null | undefined): string | null {
    const models = Array.isArray(provider?.models) ? provider.models as Array<Record<string, unknown>> : [];
    for (const model of models) {
      const value = model.embeddingModel;
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  }

  private providerEmbeddingTokenPrice(provider: Pick<ModelProviderConfig, "models">): number {
    const models = Array.isArray(provider.models) ? provider.models as Array<Record<string, unknown>> : [];
    for (const model of models) {
      const value = Number(model.embeddingTokenPrice ?? 0);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return 0;
  }

  private providerCallBudget(
    provider: ModelProviderConfig,
    model: string,
    messages: Array<{ role: string; content: string }>,
    desiredCompletionTokens: number
  ): ProviderCallBudget {
    const configuredModels = Array.isArray(provider.models) ? provider.models as Array<Record<string, unknown>> : [];
    const configured = configuredModels.find((item) => item.id === model);
    const configuredWindow = Number(configured?.contextWindow ?? provider.contextWindow);
    const contextWindow = Math.max(2, Number.isFinite(configuredWindow) ? Math.floor(configuredWindow) : 128_000);
    // For text-only requests, UTF-8 byte length is a conservative token upper
    // bound across the supported tokenizers. Include framing overhead as well.
    const serialized = JSON.stringify(messages);
    const byteUpperBound = Buffer.byteLength(serialized, "utf8") + messages.length * 16 + 64;
    const promptTokenLimit = Math.min(contextWindow - 1, Math.max(1, byteUpperBound));
    const completionTokenLimit = Math.max(
      1,
      Math.min(Math.floor(desiredCompletionTokens), contextWindow - promptTokenLimit)
    );
    return { promptTokenLimit, completionTokenLimit };
  }

  private requestKey(purpose: string, userId: string, supplied?: string): string {
    const value = supplied?.trim();
    if (value && value.length > 160) {
      throw new BadRequestException("Model request key cannot exceed 160 characters.");
    }
    const scoped = value
      ? createHash("sha256").update(`${userId}\0${value}`).digest("hex")
      : randomUUID();
    return `${purpose}:${scoped}`;
  }

  private requestHash(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  private calculateCharge(provider: ModelProviderConfig, promptTokens: number, completionTokens: number): number {
    const rawCharge = promptTokens * provider.promptTokenPrice
      + completionTokens * provider.completionTokenPrice;
    return rawCharge > 0 ? Math.max(1, Math.ceil(rawCharge)) : 0;
  }

  private calculateEmbeddingCharge(provider: ModelProviderConfig, promptTokens: number): number {
    const price = this.providerEmbeddingTokenPrice(provider);
    return price > 0 ? Math.max(1, Math.ceil(promptTokens * price)) : 0;
  }

  private modelRequestTimeoutMs(): number {
    const configured = Number(process.env.MODEL_REQUEST_TIMEOUT_MS ?? 60_000);
    return Math.min(300_000, Math.max(5_000, Number.isFinite(configured) ? configured : 60_000));
  }

  private pendingReservationStaleMs(): number {
    return this.modelRequestTimeoutMs() * 2 + 30_000;
  }

  private providerUsageTokens(value: unknown, fallback: number): number {
    const parsed = Number(value);
    const selected = Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    return Math.min(2_147_483_647, Math.max(0, Math.ceil(selected)));
  }

  private assertProviderUsage(result: ProviderCallResult): void {
    if (
      !Number.isSafeInteger(result.promptTokens)
      || result.promptTokens < 0
      || result.promptTokens > 2_147_483_647
      || !Number.isSafeInteger(result.completionTokens)
      || result.completionTokens < 0
      || result.completionTokens > 2_147_483_647
    ) {
      throw new BadRequestException("Provider token usage is invalid.");
    }
  }

  private estimateTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
  }

  private toPublicProvider(provider: ModelProviderConfig): ModelProviderPublic {
    return {
      id: provider.id,
      scope: provider.scope.toLowerCase() as ModelProviderPublic["scope"],
      kind: provider.kind.toLowerCase() as ModelProviderPublic["kind"],
      name: provider.name,
      baseUrl: provider.baseUrl,
      models: provider.models as unknown as ModelProviderPublic["models"],
      embeddingModel: this.providerEmbeddingModel(provider),
      embeddingTokenPrice: this.providerEmbeddingTokenPrice(provider),
      enabled: provider.enabled,
      promptTokenPrice: provider.promptTokenPrice,
      completionTokenPrice: provider.completionTokenPrice,
      contextWindow: provider.contextWindow
    };
  }

  private toPrismaProviderKind(kind: string): ProviderKind {
    const upper = kind.toUpperCase();
    if (!(upper in ProviderKind)) {
      throw new BadRequestException(`Unsupported provider kind: ${kind}`);
    }
    return ProviderKind[upper as keyof typeof ProviderKind];
  }

  private sealApiKey(apiKey: string): string {
    const key = this.modelSecretKey();
    if (!key) {
      throw new BadRequestException("MODEL_SECRET_KEY must be configured before saving provider credentials.");
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
  }

  private unsealApiKey(ciphertext: string): string {
    if (ciphertext === "replace-me") return ciphertext;
    if (ciphertext.startsWith("v1:")) {
      try {
        const key = this.modelSecretKey();
        if (!key) throw new Error("MODEL_SECRET_KEY is missing.");
        const [, iv, tag, encrypted] = ciphertext.split(":");
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
        decipher.setAuthTag(Buffer.from(tag, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
      } catch {
        throw new BadRequestException("Provider credential could not be decrypted. Check MODEL_SECRET_KEY.");
      }
    }
    try {
      const encoded = ciphertext.startsWith("base64:") ? ciphertext.slice(7) : ciphertext;
      return Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      return ciphertext;
    }
  }

  private modelSecretKey(): Buffer | null {
    const secret = process.env.MODEL_SECRET_KEY?.trim();
    return secret ? createHash("sha256").update(secret).digest() : null;
  }
}
