import { PrismaClient, LedgerAccount } from '@prisma/client';
import { redis } from '../redis';

type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

interface LedgerEntry {
  account: LedgerAccount;
  delta: number;     // positive = credit, negative = debit
  refType: string;
  refId: string;
  currency: string;
}

// Write double-entry ledger rows inside an existing transaction
// Always pass the Prisma tx client so this is atomic with the caller
export async function postLedgerEntries(
  tx: TxClient,
  merchantId: string,
  entries: LedgerEntry[]
): Promise<void> {
  // Invariant check: debits must equal credits
  const sum = entries.reduce((acc, e) => acc + e.delta, 0);
  if (sum !== 0) {
    throw new Error(
      `Ledger invariant violated: entries sum to ${sum}, expected 0`
    );
  }

  await tx.ledgerEntry.createMany({
    data: entries.map((e) => ({
      merchantId,
      account: e.account,
      delta: e.delta,
      currency: e.currency,
      refType: e.refType,
      refId: e.refId,
    })),
  });

  // Bust Redis balance cache
  await bustBalanceCache(merchantId, entries[0].currency).catch(() => {});
}

// Post entries for a successful capture
export async function postCapture(
  tx: TxClient,
  merchantId: string,
  transactionId: string,
  capturedAmount: number,  // total amount
  feeAmount: number,       // platform fee
  currency: string
): Promise<void> {
  const netAmount = capturedAmount - feeAmount;

  await postLedgerEntries(tx, merchantId, [
    {
      account: 'PROCESSOR',
      delta: -capturedAmount,
      refType: 'TRANSACTION',
      refId: transactionId,
      currency,
    },
    {
      account: 'PENDING',
      delta: +netAmount,
      refType: 'TRANSACTION',
      refId: transactionId,
      currency,
    },
    {
      account: 'FEES',
      delta: +feeAmount,
      refType: 'TRANSACTION',
      refId: transactionId,
      currency,
    },
  ]);
}

// Move from PENDING → AVAILABLE on settlement
export async function postSettlement(
  tx: TxClient,
  merchantId: string,
  payoutId: string,
  amount: number,
  currency: string
): Promise<void> {
  await postLedgerEntries(tx, merchantId, [
    {
      account: 'PENDING',
      delta: -amount,
      refType: 'PAYOUT',
      refId: payoutId,
      currency,
    },
    {
      account: 'AVAILABLE',
      delta: +amount,
      refType: 'PAYOUT',
      refId: payoutId,
      currency,
    },
  ]);
}

// Post entries for a refund
export async function postRefund(
  tx: TxClient,
  merchantId: string,
  refundId: string,
  amount: number,
  currency: string
): Promise<void> {
  await postLedgerEntries(tx, merchantId, [
    {
      account: 'AVAILABLE',
      delta: -amount,
      refType: 'REFUND',
      refId: refundId,
      currency,
    },
    {
      account: 'REFUNDS',
      delta: +amount,
      refType: 'REFUND',
      refId: refundId,
      currency,
    },
  ]);
}

// Hold disputed amount
export async function postDisputeOpened(
  tx: TxClient,
  merchantId: string,
  disputeId: string,
  amount: number,
  currency: string
): Promise<void> {
  await postLedgerEntries(tx, merchantId, [
    {
      account: 'AVAILABLE',
      delta: -amount,
      refType: 'DISPUTE',
      refId: disputeId,
      currency,
    },
    {
      account: 'DISPUTES',
      delta: +amount,
      refType: 'DISPUTE',
      refId: disputeId,
      currency,
    },
  ]);
}

// Release dispute hold on win
export async function postDisputeWon(
  tx: TxClient,
  merchantId: string,
  disputeId: string,
  amount: number,
  currency: string
): Promise<void> {
  await postLedgerEntries(tx, merchantId, [
    {
      account: 'DISPUTES',
      delta: -amount,
      refType: 'DISPUTE',
      refId: disputeId,
      currency,
    },
    {
      account: 'AVAILABLE',
      delta: +amount,
      refType: 'DISPUTE',
      refId: disputeId,
      currency,
    },
  ]);
}

// Query available balance — checks Redis cache first
export async function getAvailableBalance(
  merchantId: string,
  currency: string
): Promise<number> {
  const cacheKey = `balance:${merchantId}:${currency}`;
  const cached = await redis.get(cacheKey);
  if (cached !== null) return parseInt(cached, 10);

  // Cache miss — compute from ledger
  const { prisma } = await import('../db');
  const result = await prisma.$queryRaw<{ balance: bigint }[]>`
    SELECT COALESCE(SUM(delta), 0) AS balance
    FROM ledger
    WHERE "merchantId" = ${merchantId}
      AND currency = ${currency}
      AND account = 'AVAILABLE'
  `;

  const balance = Number(result[0].balance);
  await redis.setex(cacheKey, 30, balance.toString());
  return balance;
}

async function bustBalanceCache(
  merchantId: string,
  currency: string
): Promise<void> {
  await redis.del(`balance:${merchantId}:${currency}`);
}
