import assert from "node:assert/strict";
import test from "node:test";
import { RechargeOrderStatus, TokenTransactionKind, UserRole } from "@prisma/client";
import { hashSessionToken } from "../../common/password";
import { UsersService } from "./users.service";
import { PrismaService } from "../../common/prisma.service";
import { RateLimitService } from "../../common/rate-limit.service";
import { WalletService } from "../billing/wallet.service";
import { UserAccessService } from "./user-access.service";

function serviceWith(prisma: unknown, rateLimit: unknown = {}) {
  const client = prisma as PrismaService;
  return new UsersService(client, rateLimit as RateLimitService, new WalletService(), new UserAccessService(client));
}

test("admin token adjustments use atomic increments and ledger the committed balance", async () => {
  let balance = 100;
  const transactionRows: any[] = [];
  const targetUser = () => ({
    id: "target-1",
    username: "target",
    email: null,
    passwordHash: "",
    displayName: "Target",
    avatarUrl: null,
    role: UserRole.USER,
    tokenBalance: balance,
    createdAt: new Date(),
    updatedAt: new Date()
  });
  const prisma = {
    user: {
      findUnique: async ({ where }: any) => where.id === "admin-1"
        ? { ...targetUser(), id: "admin-1", username: "admin", role: UserRole.ADMIN }
        : targetUser()
    },
    $transaction: async (callback: any) => callback({
      user: {
        updateMany: async ({ where, data }: any) => {
          if (data.tokenBalance.decrement) {
            if (balance < where.tokenBalance.gte) return { count: 0 };
            balance -= data.tokenBalance.decrement;
          } else {
            if (balance > where.tokenBalance.lte) return { count: 0 };
            balance += data.tokenBalance.increment;
          }
          return { count: 1 };
        },
        findUniqueOrThrow: async () => targetUser()
      },
      tokenTransaction: {
        create: async ({ data }: any) => {
          transactionRows.push(data);
          return { id: `tx-${transactionRows.length}`, ...data };
        }
      }
    })
  };
  const service = serviceWith(prisma);

  await service.adjustTokens("admin-1", "target-1", 25, TokenTransactionKind.ADMIN_ADJUSTMENT);
  await service.adjustTokens("admin-1", "target-1", -40, TokenTransactionKind.ADMIN_ADJUSTMENT);

  assert.equal(balance, 85);
  assert.deepEqual(transactionRows.map((row) => [row.amount, row.balanceAfter]), [[25, 125], [-40, 85]]);
});

test("admin token adjustment rejects an atomic decrement that would overdraw", async () => {
  const prisma = {
    user: {
      findUnique: async ({ where }: any) => ({
        id: where.id,
        username: where.id,
        email: null,
        passwordHash: "",
        displayName: where.id,
        avatarUrl: null,
        role: where.id === "admin-1" ? UserRole.ADMIN : UserRole.USER,
        tokenBalance: 10,
        createdAt: new Date(),
        updatedAt: new Date()
      })
    },
    $transaction: async (callback: any) => callback({
      user: { updateMany: async () => ({ count: 0 }) },
      tokenTransaction: { create: async () => assert.fail("ledger must not be written") }
    })
  };

  await assert.rejects(
    () => serviceWith(prisma).adjustTokens(
      "admin-1",
      "target-1",
      -11,
      TokenTransactionKind.ADMIN_ADJUSTMENT
    ),
    /cannot become negative/
  );
});

test("admin token adjustment rejects an atomic increment above the balance ceiling", async () => {
  const prisma = {
    user: {
      findUnique: async ({ where }: any) => ({
        id: where.id,
        username: where.id,
        email: null,
        passwordHash: "",
        displayName: where.id,
        avatarUrl: null,
        role: where.id === "admin-1" ? UserRole.ADMIN : UserRole.USER,
        tokenBalance: 1_999_999_999,
        createdAt: new Date(),
        updatedAt: new Date()
      })
    },
    $transaction: async (callback: any) => callback({
      user: { updateMany: async () => ({ count: 0 }) },
      tokenTransaction: { create: async () => assert.fail("ledger must not be written") }
    })
  };

  await assert.rejects(
    () => serviceWith(prisma).adjustTokens(
      "admin-1",
      "target-1",
      2,
      TokenTransactionKind.ADMIN_ADJUSTMENT
    ),
    /cannot exceed/
  );
});

test("wallet summary separates model spending, service fees, and per-agent earnings", async () => {
  const prisma = {
    user: {
      findUnique: async () => ({
        id: "creator-1",
        username: "creator",
        email: null,
        passwordHash: "",
        displayName: "Creator",
        avatarUrl: null,
        role: UserRole.CREATOR,
        tokenBalance: 84,
        createdAt: new Date(),
        updatedAt: new Date()
      })
    },
    tokenTransaction: {
      findMany: async (input: any) => input.select
        ? [
          { amount: 7, metadata: { agentId: "agent-1" } },
          { amount: 3, metadata: { agentId: "agent-1" } }
        ]
        : [{ id: "tx-1", amount: 7, kind: TokenTransactionKind.AGENT_SERVICE_EARNING }],
      aggregate: async (input: any) => {
        const kind = input.where.kind;
        if (!kind) return { _sum: { amount: -26 } };
        if (kind.in) return { _sum: { amount: -18 } };
        if (kind === TokenTransactionKind.AGENT_SERVICE_FEE) return { _sum: { amount: -8 } };
        return { _sum: { amount: 10 } };
      }
    },
    agent: { findMany: async () => [{ id: "agent-1", name: "Mira" }] }
  };

  const summary = await serviceWith(prisma).walletSummary("creator-1");
  assert.equal(summary.balance, 84);
  assert.equal(summary.totalSpent, 26);
  assert.equal(summary.modelSpent, 18);
  assert.equal(summary.serviceFeesPaid, 8);
  assert.equal(summary.serviceEarnings, 10);
  assert.deepEqual(summary.agentEarnings, [{ agentId: "agent-1", agentName: "Mira", amount: 10, transactionCount: 2 }]);
});

test("a configured recharge pilot restricts access without exposing the username", async () => {
  process.env.PAYMENT_PILOT_USERNAME = "pilot-user";
  const prisma = {
    user: {
      findUnique: async () => ({
        id: "jiang_yy",
        username: "jiang_yy",
        email: "jy@outlook.com",
        passwordHash: "",
        displayName: "jiang_yy",
        avatarUrl: null,
        role: UserRole.USER,
        tokenBalance: 20_000_000,
        createdAt: new Date(),
        updatedAt: new Date()
      })
    }
  };
  await assert.rejects(
    () => serviceWith(prisma).createRechargeOrder("jiang_yy", { amount: 1, unit: "m" }),
    /not available for this account/
  );
});

test("a configured pilot recharge creates a pending bank transfer order without crediting tokens", async () => {
  process.env.PAYMENT_PILOT_USERNAME = "pilot_user";
  process.env.PAYMENT_ACCOUNT_NUMBER = "6214000011116181";
  process.env.PAYMENT_BANK_NAME = "Test Bank";
  process.env.PAYMENT_ACCOUNT_NAME = "Test Payee";
  process.env.PAYMENT_CNY_PER_M_TOKEN = "2";
  const prisma = {
    user: {
      findUnique: async () => ({
        id: "pilot_user",
        username: "pilot_user",
        email: "yaozher@outlook.com",
        passwordHash: "",
        displayName: "pilot_user",
        avatarUrl: null,
        role: UserRole.USER,
        tokenBalance: 100_000_000,
        createdAt: new Date("2026-06-24T00:00:00Z"),
        updatedAt: new Date()
      })
    },
    rechargeOrder: {
      updateMany: async () => ({ count: 0 }),
      create: async ({ data }: any) => ({
        id: "order-1",
        status: RechargeOrderStatus.PENDING,
        adminNote: "",
        paidTransactionId: null,
        submittedAt: null,
        reviewedAt: null,
        createdAt: new Date("2026-06-24T00:00:00Z"),
        updatedAt: new Date("2026-06-24T00:00:00Z"),
        ...data
      })
    }
  };
  const rateLimit = { consume: async () => ({ allowed: true, limit: 6, remaining: 5, retryAfterSeconds: 0 }) };

  const result = await serviceWith(prisma, rateLimit).createRechargeOrder("pilot_user", { amount: 2, unit: "m" });
  assert.equal(result.amountTokens, 2_000_000);
  assert.equal(result.payableCny, 4);
  assert.equal(result.status, "pending");
  assert.equal(result.paymentAccount.accountNumber, "6214000011116181");
});

test("blank recharge pilot allows every authenticated user and is not returned to clients", async () => {
  process.env.PAYMENT_PILOT_USERNAME = "";
  const prisma = {
    user: {
      findUnique: async () => ({
        id: "user-1", username: "any-user", email: null, passwordHash: "", displayName: "Any User",
        avatarUrl: null, role: UserRole.USER, tokenBalance: 0, createdAt: new Date(), updatedAt: new Date()
      })
    }
  };

  const config = await serviceWith(prisma).rechargeConfig("user-1");
  assert.equal(config.allowed, true);
  assert.equal("allowedUsername" in config, false);
});

test("email binding code sends are limited by both target email and requesting user", async () => {
  const buckets: string[] = [];
  const rateLimit = {
    consume: async (bucket: string) => {
      buckets.push(bucket);
      return { allowed: true, limit: 5, remaining: 4, retryAfterSeconds: 0 };
    }
  };
  const service = serviceWith({}, rateLimit) as any;

  await service.assertEmailCodeRateLimit("target@example.com", "bind_email", "user-1");
  assert.deepEqual(buckets, ["email-code:bind_email", "email-code-actor:bind_email"]);
});

test("email binding verification code is consumed atomically", async () => {
  const code = "654321";
  const prisma = {
    emailVerificationCode: {
      findFirst: async () => ({ id: "code-1", codeHash: hashSessionToken(code) }),
      updateMany: async () => ({ count: 0 })
    }
  };
  const rateLimit = {
    consume: async () => ({ allowed: true, limit: 8, remaining: 7, retryAfterSeconds: 0 })
  };
  const service = serviceWith(prisma, rateLimit) as any;

  await assert.rejects(service.consumeCode("target@example.com", "bind_email", code), /验证码/);
});

test("admin confirmation credits a recharge order exactly once", async () => {
  process.env.PAYMENT_ACCOUNT_NUMBER = "6214000011116181";
  let transactionData: any = null;
  const order = {
    id: "order-1",
    orderNo: "CHQ20260624ABCD",
    userId: "pilot_user",
    status: RechargeOrderStatus.SUBMITTED,
    amountTokens: 2_000_000,
    requestedAmount: 2,
    requestedUnit: "m",
    payableCny: 2,
    paymentMethod: "bank_transfer",
    paymentReference: "CHQ-ABCD1234",
    payerNote: "paid",
    adminNote: "",
    paidTransactionId: null,
    submittedAt: new Date("2026-06-24T00:00:00Z"),
    reviewedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date("2026-06-24T00:00:00Z"),
    updatedAt: new Date("2026-06-24T00:00:00Z")
  };
  const prisma = {
    user: {
      findUnique: async () => ({
        id: "admin-local",
        username: "admin",
        email: null,
        passwordHash: "",
        displayName: "Admin",
        avatarUrl: null,
        role: UserRole.ADMIN,
        tokenBalance: 9999,
        createdAt: new Date(),
        updatedAt: new Date()
      })
    },
    rechargeOrder: { updateMany: async () => ({ count: 0 }) },
    $transaction: async (callback: any) => callback({
      rechargeOrder: {
        findUnique: async () => order,
        updateMany: async () => ({ count: 1 }),
        update: async ({ data }: any) => ({ ...order, status: RechargeOrderStatus.PAID, ...data, reviewedAt: new Date() })
      },
      user: {
        update: async () => ({ tokenBalance: 102_000_000 })
      },
      tokenTransaction: {
        create: async ({ data }: any) => {
          transactionData = data;
          return { id: "tx-recharge", ...data, createdAt: new Date() };
        }
      }
    })
  };

  const result = await serviceWith(prisma).moderateRechargeOrder("admin-local", "order-1", "confirm");
  assert.equal(result.status, "paid");
  assert.equal(transactionData.kind, TokenTransactionKind.RECHARGE);
  assert.equal(transactionData.amount, 2_000_000);
  assert.equal(transactionData.balanceAfter, 102_000_000);
  assert.equal(transactionData.metadata.rechargeOrderId, "order-1");
});
