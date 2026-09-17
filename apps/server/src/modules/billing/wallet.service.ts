import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { Prisma, TokenTransaction, TokenTransactionKind } from "@prisma/client";

const maxTokenBalance = 2_000_000_000;

export type WalletCharge = {
  amount: number;
  kind: TokenTransactionKind;
  note: string;
  metadata?: Prisma.InputJsonValue;
};

/**
 * Balance mutations and their ledger entries share the caller's transaction.
 * These methods never open or commit a transaction. The caller must pass its
 * active transaction and let failures roll it back, together with the related
 * reservation, order or model-call log. The caller also owns authorization and
 * idempotency: a reservation hold/release must follow a successful state claim.
 */
@Injectable()
export class WalletService {
  async adjustTokensInTransaction(
    tx: Prisma.TransactionClient,
    targetUserId: string,
    amount: number,
    kind: TokenTransactionKind,
    note?: string
  ) {
    if (!Number.isSafeInteger(amount) || amount === 0) {
      throw new BadRequestException("Token adjustment must be a non-zero safe integer.");
    }

    if (amount < 0) {
      const changed = await tx.user.updateMany({
        where: { id: targetUserId, tokenBalance: { gte: -amount } },
        data: { tokenBalance: { decrement: -amount } }
      });
      if (!changed.count) {
        throw new ForbiddenException("Token balance cannot become negative.");
      }
    } else {
      const changed = await tx.user.updateMany({
        where: { id: targetUserId, tokenBalance: { lte: maxTokenBalance - amount } },
        data: { tokenBalance: { increment: amount } }
      });
      if (!changed.count) {
        throw new ForbiddenException(`Token balance cannot exceed ${maxTokenBalance}.`);
      }
    }
    const user = await tx.user.findUniqueOrThrow({ where: { id: targetUserId } });
    const transaction = await tx.tokenTransaction.create({
      data: {
        userId: targetUserId,
        kind,
        amount,
        balanceAfter: user.tokenBalance,
        note
      }
    });
    return { user, transaction };
  }

  async chargeForModelUsageInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    amount: number,
    note: string,
    metadata?: Prisma.InputJsonValue,
    kind: TokenTransactionKind = TokenTransactionKind.CLOUD_MODEL_USAGE
  ): Promise<number> {
    const changed = await tx.user.updateMany({
      where: { id: userId, tokenBalance: { gte: amount } },
      data: { tokenBalance: { decrement: amount } }
    });
    if (!changed.count) {
      throw new ForbiddenException("Token balance is insufficient for this model call.");
    }
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { tokenBalance: true } });
    await tx.tokenTransaction.create({
      data: {
        userId,
        kind,
        amount: -amount,
        balanceAfter: user.tokenBalance,
        note,
        metadata
      }
    });
    return user.tokenBalance;
  }

  /**
   * Places a temporary hold by removing tokens from the spendable balance.
   * No ledger entry is written until the external call is settled, so failed
   * calls can be released without creating artificial usage/refund rows.
   */
  async reserveTokensInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    amount: number
  ): Promise<number> {
    if (!Number.isInteger(amount) || amount < 0) {
      throw new BadRequestException("Token reservation amount must be a non-negative integer.");
    }
    if (amount > 0) {
      const changed = await tx.user.updateMany({
        where: { id: userId, tokenBalance: { gte: amount } },
        data: { tokenBalance: { decrement: amount } }
      });
      if (!changed.count) {
        throw new ForbiddenException("Token balance is insufficient for the maximum cost of this model call.");
      }
    }
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { tokenBalance: true } });
    return user.tokenBalance;
  }

  async releaseTokenReservationInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    reservedTokens: number
  ): Promise<number> {
    if (!Number.isInteger(reservedTokens) || reservedTokens < 0) {
      throw new BadRequestException("Reserved token amount must be a non-negative integer.");
    }
    if (reservedTokens === 0) {
      return (await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { tokenBalance: true } })).tokenBalance;
    }
    const user = await tx.user.update({
      where: { id: userId },
      data: { tokenBalance: { increment: reservedTokens } },
      select: { tokenBalance: true }
    });
    return user.tokenBalance;
  }

  async settleTokenReservationInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    reservedTokens: number,
    charges: readonly WalletCharge[]
  ): Promise<number> {
    const actualCharge = charges.reduce((sum, charge) => sum + charge.amount, 0);
    if (!Number.isInteger(reservedTokens) || reservedTokens < 0 || charges.some((charge) => !Number.isInteger(charge.amount) || charge.amount < 0)) {
      throw new BadRequestException("Token settlement amounts must be non-negative integers.");
    }
    if (actualCharge > reservedTokens) {
      throw new BadRequestException("Actual model charge exceeded the reserved maximum.");
    }
    const refund = reservedTokens - actualCharge;
    const finalBalance = refund > 0
      ? (await tx.user.update({
        where: { id: userId },
        data: { tokenBalance: { increment: refund } },
        select: { tokenBalance: true }
      })).tokenBalance
      : (await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { tokenBalance: true } })).tokenBalance;
    let followingCharges = actualCharge;
    for (const charge of charges) {
      followingCharges -= charge.amount;
      if (charge.amount === 0) continue;
      await tx.tokenTransaction.create({
        data: {
          userId,
          kind: charge.kind,
          amount: -charge.amount,
          balanceAfter: finalBalance + followingCharges,
          note: charge.note,
          metadata: charge.metadata
        }
      });
    }
    return finalBalance;
  }

  async creditTokensInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    amount: number,
    note: string,
    metadata?: Prisma.InputJsonValue,
    kind: TokenTransactionKind = TokenTransactionKind.AGENT_SERVICE_EARNING
  ): Promise<number> {
    if (amount <= 0) return (await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { tokenBalance: true } })).tokenBalance;
    const user = await tx.user.update({
      where: { id: userId },
      data: { tokenBalance: { increment: amount } },
      select: { tokenBalance: true }
    });
    await tx.tokenTransaction.create({
      data: { userId, kind, amount, balanceAfter: user.tokenBalance, note, metadata }
    });
    return user.tokenBalance;
  }

  async creditRechargeInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    amount: number,
    note: string,
    metadata: Prisma.InputJsonValue
  ): Promise<TokenTransaction> {
    const user = await tx.user.update({
      where: { id: userId },
      data: { tokenBalance: { increment: amount } },
      select: { tokenBalance: true }
    });
    if (user.tokenBalance > maxTokenBalance) {
      throw new BadRequestException("Token balance would exceed the current platform limit.");
    }
    const transaction = await tx.tokenTransaction.create({
      data: {
        userId,
        kind: TokenTransactionKind.RECHARGE,
        amount,
        balanceAfter: user.tokenBalance,
        note,
        metadata
      }
    });
    return transaction;
  }
}
