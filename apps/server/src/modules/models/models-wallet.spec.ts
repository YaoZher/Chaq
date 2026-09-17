import assert from "node:assert/strict";
import test from "node:test";
import { ModelCallPurpose, ModelCallReservation, ModelCallReservationStatus, Prisma, TokenTransactionKind } from "@prisma/client";
import { PrismaService } from "../../common/prisma.service";
import { WalletService } from "../billing/wallet.service";
import { UserAccessService } from "../users/user-access.service";
import { ModelsService } from "./models.service";

type ReserveInput = Pick<ModelCallReservation,
  "requestKey" | "requestHash" | "purpose" | "userId" | "model" | "reservedTokens" | "promptTokenLimit" | "completionTokenLimit"
> & { providerId: string; serviceFee?: number; beneficiaryUserId?: string | null };

type SettleInput = {
  result: { content: string; promptTokens: number; completionTokens: number };
  modelCharge: number;
  serviceFee: number;
  beneficiaryUserId?: string;
  agentRunId?: string;
  agentId?: string;
  response: Prisma.InputJsonValue;
  modelNote: string;
};

type ModelBillingOperations = {
  reserveModelCall(input: ReserveInput): Promise<{ state: string; reservation: ModelCallReservation }>;
  settleModelCall(claim: Pick<ModelCallReservation, "id" | "attempt">, input: SettleInput): Promise<{
    reservation: ModelCallReservation;
    balanceAfter: number;
  }>;
  failModelCall(claim: Pick<ModelCallReservation, "id" | "attempt">, error: unknown, promptTokens: number): Promise<void>;
};

type LedgerRow = {
  userId: string;
  kind: TokenTransactionKind;
  amount: number;
  balanceAfter: number;
  metadata?: Prisma.InputJsonValue;
};

type FixtureState = {
  balances: Record<string, number>;
  reservation: ModelCallReservation | null;
  ledger: LedgerRow[];
  logCount: number;
};

const reserveInput: ReserveInput = {
  requestKey: "agent-run:run-1:completion",
  requestHash: "hash-1",
  purpose: ModelCallPurpose.AGENT_COMPLETION,
  userId: "payer",
  providerId: "provider-1",
  model: "model-1",
  reservedTokens: 100,
  promptTokenLimit: 80,
  completionTokenLimit: 20,
  serviceFee: 10,
  beneficiaryUserId: "owner"
};

const settlementInput: SettleInput = {
  result: { content: "hello", promptTokens: 10, completionTokens: 5 },
  modelCharge: 20,
  serviceFee: 10,
  beneficiaryUserId: "owner",
  agentRunId: "run-1",
  agentId: "agent-1",
  response: { content: "hello", promptTokens: 10, completionTokens: 5, modelLabel: "Provider / model-1" },
  modelNote: "Agent run"
};

// This in-memory transaction commits only after the callback succeeds. It tests
// that ModelsService passes one transaction through real wallet mutations and
// propagates failures; it does not simulate PostgreSQL isolation or concurrency.
function modelWalletFixture(payerBalance = 200) {
  let committed: FixtureState = {
    balances: { payer: payerBalance, owner: 500 },
    reservation: null,
    ledger: [],
    logCount: 0
  };
  let rejectedLedgerKind: TokenTransactionKind | undefined;
  const prisma = {
    $transaction: async <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
      const state = structuredClone(committed);
      const requiredReservation = () => {
        assert.ok(state.reservation, "reservation must exist");
        return state.reservation;
      };
      const tx = {
        user: {
          updateMany: async ({ where, data }: {
            where: { id: string; tokenBalance: { gte: number } };
            data: { tokenBalance: { decrement: number } };
          }) => {
            if (state.balances[where.id] < where.tokenBalance.gte) return { count: 0 };
            state.balances[where.id] -= data.tokenBalance.decrement;
            return { count: 1 };
          },
          update: async ({ where, data }: {
            where: { id: string };
            data: { tokenBalance: { increment: number } };
          }) => {
            state.balances[where.id] += data.tokenBalance.increment;
            return { tokenBalance: state.balances[where.id] };
          },
          findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ tokenBalance: state.balances[where.id] })
        },
        modelCallReservation: {
          findUnique: async () => state.reservation,
          findUniqueOrThrow: async () => requiredReservation(),
          create: async ({ data }: { data: ReserveInput }) => {
            state.reservation = {
              ...data,
              id: "reservation-1",
              attempt: 1,
              status: ModelCallReservationStatus.PENDING,
              chargedTokens: 0,
              promptTokens: 0,
              completionTokens: 0,
              serviceFee: data.serviceFee ?? 0,
              beneficiaryUserId: data.beneficiaryUserId ?? null,
              response: null,
              error: null,
              settledAt: null,
              createdAt: new Date(),
              updatedAt: new Date()
            };
            return state.reservation;
          },
          updateMany: async ({ where, data }: {
            where: Pick<ModelCallReservation, "id" | "attempt" | "status">;
            data: Partial<ModelCallReservation>;
          }) => {
            const reservation = requiredReservation();
            if (reservation.id !== where.id || reservation.attempt !== where.attempt || reservation.status !== where.status) return { count: 0 };
            state.reservation = { ...reservation, ...data };
            return { count: 1 };
          }
        },
        tokenTransaction: {
          create: async ({ data }: { data: LedgerRow }) => {
            if (data.kind === rejectedLedgerKind) throw new Error("beneficiary ledger unavailable");
            state.ledger.push(data);
            return { id: `ledger-${state.ledger.length}`, ...data };
          }
        },
        modelCallLog: { create: async () => { state.logCount += 1; } }
      };
      const result = await callback(tx as unknown as Prisma.TransactionClient);
      committed = state;
      return result;
    }
  };
  const client = prisma as unknown as PrismaService;
  const models = new ModelsService(client, new WalletService(), new UserAccessService(client));
  return {
    models: models as unknown as ModelBillingOperations,
    snapshot: () => structuredClone(committed),
    rejectLedger: (kind?: TokenTransactionKind) => { rejectedLedgerKind = kind; }
  };
}

test("model reservation cannot leave a hold or pending request when the wallet balance is insufficient", async () => {
  const fixture = modelWalletFixture(99);
  const before = fixture.snapshot();
  await assert.rejects(fixture.models.reserveModelCall(reserveInput), /insufficient/);
  assert.deepEqual(fixture.snapshot(), before);
});

test("model settlement refunds unused hold and transfers the service fee once through the wallet", async () => {
  const fixture = modelWalletFixture();
  const claim = await fixture.models.reserveModelCall(reserveInput);
  assert.equal(claim.state, "acquired");
  assert.equal(fixture.snapshot().balances.payer, 100);
  const settled = await fixture.models.settleModelCall(claim.reservation, settlementInput);
  assert.equal(settled.balanceAfter, 170);
  assert.equal(settled.reservation.chargedTokens, 30);
  const state = fixture.snapshot();
  assert.deepEqual(state.balances, { payer: 170, owner: 510 });
  assert.deepEqual(state.ledger.map(({ userId, kind, amount, balanceAfter }) => ({ userId, kind, amount, balanceAfter })), [
    { userId: "payer", kind: TokenTransactionKind.AGENT_MODEL_USAGE, amount: -20, balanceAfter: 180 },
    { userId: "payer", kind: TokenTransactionKind.AGENT_SERVICE_FEE, amount: -10, balanceAfter: 170 },
    { userId: "owner", kind: TokenTransactionKind.AGENT_SERVICE_EARNING, amount: 10, balanceAfter: 510 }
  ]);
  assert.equal(state.logCount, 1);
  await fixture.models.settleModelCall(claim.reservation, settlementInput);
  assert.deepEqual(fixture.snapshot(), state);
});

test("beneficiary credit failure rolls back settlement, refund, debit ledger, and model log together", async () => {
  const fixture = modelWalletFixture();
  const claim = await fixture.models.reserveModelCall(reserveInput);
  const held = fixture.snapshot();
  fixture.rejectLedger(TokenTransactionKind.AGENT_SERVICE_EARNING);
  await assert.rejects(fixture.models.settleModelCall(claim.reservation, settlementInput), /beneficiary ledger unavailable/);
  assert.deepEqual(fixture.snapshot(), held);
  fixture.rejectLedger();
  await fixture.models.settleModelCall(claim.reservation, settlementInput);
  assert.deepEqual(fixture.snapshot().balances, { payer: 170, owner: 510 });
  assert.equal(fixture.snapshot().ledger.length, 3);
});

test("failed model calls release the hold once without charging the payer or paying the owner", async () => {
  const fixture = modelWalletFixture();
  const claim = await fixture.models.reserveModelCall(reserveInput);
  await fixture.models.failModelCall(claim.reservation, new Error("model unavailable"), 5);
  const failed = fixture.snapshot();
  assert.deepEqual(failed.balances, { payer: 200, owner: 500 });
  assert.deepEqual(failed.ledger, []);
  assert.equal(failed.reservation?.status, ModelCallReservationStatus.FAILED);
  assert.equal(failed.logCount, 1);
  await fixture.models.failModelCall(claim.reservation, new Error("late retry"), 5);
  assert.deepEqual(fixture.snapshot(), failed);
});

test("reusing a pending model request with changed input cannot reserve more wallet funds", async () => {
  const fixture = modelWalletFixture();
  await fixture.models.reserveModelCall(reserveInput);
  const held = fixture.snapshot();
  await assert.rejects(fixture.models.reserveModelCall({ ...reserveInput, requestHash: "changed-input" }), /different input/);
  assert.deepEqual(fixture.snapshot(), held);
});
