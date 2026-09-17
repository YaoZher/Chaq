import assert from "node:assert/strict";
import test from "node:test";
import { Prisma, TokenTransactionKind } from "@prisma/client";
import { WalletService } from "./wallet.service";

type LedgerRow = {
  userId: string;
  kind: TokenTransactionKind;
  amount: number;
  balanceAfter: number;
};

function walletFixture(initialBalance: number) {
  let balance = initialBalance;
  const ledger: LedgerRow[] = [];
  const client = {
    user: {
      updateMany: async ({ where, data }: {
        where: { tokenBalance: { gte?: number; lte?: number } };
        data: { tokenBalance: { increment?: number; decrement?: number } };
      }) => {
        if (where.tokenBalance.gte !== undefined && balance < where.tokenBalance.gte) return { count: 0 };
        if (where.tokenBalance.lte !== undefined && balance > where.tokenBalance.lte) return { count: 0 };
        balance += (data.tokenBalance.increment ?? 0) - (data.tokenBalance.decrement ?? 0);
        return { count: 1 };
      },
      update: async ({ data }: { data: { tokenBalance: { increment: number } } }) => {
        balance += data.tokenBalance.increment;
        return { tokenBalance: balance };
      },
      findUniqueOrThrow: async () => ({ tokenBalance: balance })
    },
    tokenTransaction: {
      create: async ({ data }: { data: LedgerRow }) => {
        ledger.push(data);
        return { id: `ledger-${ledger.length}`, ...data };
      }
    }
  };
  return {
    wallet: new WalletService(),
    tx: client as unknown as Prisma.TransactionClient,
    balance: () => balance,
    ledger
  };
}

test("wallet rejects an unaffordable hold without changing balance or ledger", async () => {
  const { wallet, tx, balance, ledger } = walletFixture(30);
  await assert.rejects(wallet.reserveTokensInTransaction(tx, "payer", 31), /insufficient/);
  assert.equal(balance(), 30);
  assert.deepEqual(ledger, []);
});

test("wallet holds and releases spendable tokens without artificial ledger rows", async () => {
  const { wallet, tx, balance, ledger } = walletFixture(100);
  assert.equal(await wallet.reserveTokensInTransaction(tx, "payer", 40), 60);
  assert.equal(await wallet.releaseTokenReservationInTransaction(tx, "payer", 40), 100);
  assert.equal(await wallet.reserveTokensInTransaction(tx, "payer", 0), 100);
  assert.equal(await wallet.releaseTokenReservationInTransaction(tx, "payer", 0), 100);
  assert.equal(balance(), 100);
  assert.deepEqual(ledger, []);
});

test("wallet settlement refunds unused tokens and records each charge's resulting balance", async () => {
  const { wallet, tx, balance, ledger } = walletFixture(200);
  await wallet.reserveTokensInTransaction(tx, "payer", 100);
  assert.equal(await wallet.settleTokenReservationInTransaction(tx, "payer", 100, [
    { amount: 20, kind: TokenTransactionKind.AGENT_MODEL_USAGE, note: "model" },
    { amount: 0, kind: TokenTransactionKind.AGENT_MODEL_USAGE, note: "free operation" },
    { amount: 10, kind: TokenTransactionKind.AGENT_SERVICE_FEE, note: "service" }
  ]), 170);
  assert.equal(balance(), 170);
  assert.deepEqual(ledger.map(({ kind, amount, balanceAfter }) => ({ kind, amount, balanceAfter })), [
    { kind: TokenTransactionKind.AGENT_MODEL_USAGE, amount: -20, balanceAfter: 180 },
    { kind: TokenTransactionKind.AGENT_SERVICE_FEE, amount: -10, balanceAfter: 170 }
  ]);
});

test("wallet rejects invalid holds and over-budget settlement before mutation", async () => {
  const { wallet, tx, balance, ledger } = walletFixture(100);
  for (const amount of [-1, 0.5, Number.NaN]) {
    await assert.rejects(wallet.reserveTokensInTransaction(tx, "payer", amount), /non-negative integer/);
    await assert.rejects(wallet.releaseTokenReservationInTransaction(tx, "payer", amount), /non-negative integer/);
  }
  await assert.rejects(wallet.settleTokenReservationInTransaction(tx, "payer", 20, [
    { amount: 21, kind: TokenTransactionKind.CLOUD_MODEL_USAGE, note: "model" }
  ]), /exceeded the reserved maximum/);
  await assert.rejects(wallet.settleTokenReservationInTransaction(tx, "payer", 20, [
    { amount: -1, kind: TokenTransactionKind.CLOUD_MODEL_USAGE, note: "model" }
  ]), /non-negative integers/);
  assert.equal(balance(), 100);
  assert.deepEqual(ledger, []);
});

test("wallet direct charges preserve insufficient-balance behavior and ledger the resulting balance", async () => {
  const { wallet, tx, balance, ledger } = walletFixture(50);
  assert.equal(await wallet.chargeForModelUsageInTransaction(tx, "payer", 30, "model"), 20);
  await assert.rejects(wallet.chargeForModelUsageInTransaction(tx, "payer", 21, "model"), /insufficient/);
  assert.equal(balance(), 20);
  assert.deepEqual(ledger.map(({ amount, balanceAfter }) => ({ amount, balanceAfter })), [{ amount: -30, balanceAfter: 20 }]);
});
