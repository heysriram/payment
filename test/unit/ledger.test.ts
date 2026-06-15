// We mock the redis module so the ledger's cache-bust is a no-op.
jest.mock('../../src/redis', () => ({
  redis: {
    del: jest.fn(async () => 0),
    get: jest.fn(async () => null),
    setex: jest.fn(async () => 'OK'),
  },
}));

import {
  postCapture,
  postRefund,
  postSettlement,
  postDisputeOpened,
  postDisputeWon,
  postLedgerEntries,
} from '../../src/services/ledger';

interface CreatedEntry {
  account: string;
  delta: number;
  refType: string;
  refId: string;
  currency: string;
}

function makeFakeTx() {
  const entries: CreatedEntry[] = [];
  return {
    entries,
    tx: {
      ledgerEntry: {
        createMany: async ({ data }: { data: CreatedEntry[] }) => {
          entries.push(...data);
          return { count: data.length };
        },
      },
    } as unknown as Parameters<typeof postCapture>[0],
  };
}

describe('ledger invariants', () => {
  it('postCapture writes 3 entries that sum to zero', async () => {
    const { entries, tx } = makeFakeTx();
    await postCapture(tx, 'm1', 'txn_1', 10_000, 200, 'INR');
    expect(entries).toHaveLength(3);
    expect(entries.reduce((a, e) => a + e.delta, 0)).toBe(0);
    // PROCESSOR debited the gross, PENDING credited the net, FEES credited the fee.
    const accounts = entries.map((e) => e.account).sort();
    expect(accounts).toEqual(['FEES', 'PENDING', 'PROCESSOR']);
  });

  it('postSettlement moves PENDING → AVAILABLE (sums to zero)', async () => {
    const { entries, tx } = makeFakeTx();
    await postSettlement(tx, 'm1', 'po_1', 9_800, 'INR');
    expect(entries.reduce((a, e) => a + e.delta, 0)).toBe(0);
    expect(entries.find((e) => e.account === 'PENDING')?.delta).toBe(-9800);
    expect(entries.find((e) => e.account === 'AVAILABLE')?.delta).toBe(9800);
  });

  it('postRefund debits AVAILABLE and credits REFUNDS', async () => {
    const { entries, tx } = makeFakeTx();
    await postRefund(tx, 'm1', 'rfnd_1', 5_000, 'INR');
    expect(entries.reduce((a, e) => a + e.delta, 0)).toBe(0);
    expect(entries.find((e) => e.account === 'AVAILABLE')?.delta).toBe(-5000);
    expect(entries.find((e) => e.account === 'REFUNDS')?.delta).toBe(5000);
  });

  it('postDisputeOpened/postDisputeWon reverse each other', async () => {
    const opened = makeFakeTx();
    await postDisputeOpened(opened.tx, 'm1', 'dsp_1', 7_500, 'INR');
    expect(opened.entries.reduce((a, e) => a + e.delta, 0)).toBe(0);

    const won = makeFakeTx();
    await postDisputeWon(won.tx, 'm1', 'dsp_1', 7_500, 'INR');
    expect(won.entries.reduce((a, e) => a + e.delta, 0)).toBe(0);

    // Combined effect must be zero per account
    const combined: Record<string, number> = {};
    for (const e of [...opened.entries, ...won.entries]) {
      combined[e.account] = (combined[e.account] ?? 0) + e.delta;
    }
    expect(combined.AVAILABLE ?? 0).toBe(0);
    expect(combined.DISPUTES ?? 0).toBe(0);
  });

  it('postLedgerEntries throws when entries do not sum to zero', async () => {
    const { tx } = makeFakeTx();
    await expect(
      postLedgerEntries(tx, 'm1', [
        { account: 'AVAILABLE', delta: 100, refType: 'X', refId: 'a', currency: 'INR' },
        { account: 'PROCESSOR', delta: -50, refType: 'X', refId: 'a', currency: 'INR' },
      ])
    ).rejects.toThrow(/Ledger invariant violated/);
  });
});
