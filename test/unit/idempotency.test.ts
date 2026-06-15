/**
 * Pure-unit test for the idempotency contract on POST /v1/payment_intents.
 *
 * We mock `../../src/db` and the auth middleware so the route handler runs
 * against an in-memory store. No Postgres / Redis required.
 *
 * We assert:
 *   1. First POST → 201 + new intent.
 *   2. Same Idempotency-Key replay → 200 + same id + `idempotent: true`.
 *   3. Missing Idempotency-Key → 400 validation_error.
 */

const intentsByMerchantKey = new Map<string, { id: string; merchantId: string; idempotencyKey: string; status: string }>();
let intentCounter = 0;

jest.mock('../../src/db', () => ({
  prisma: {
    paymentIntent: {
      findUnique: async ({ where }: { where: { merchantId_idempotencyKey?: { merchantId: string; idempotencyKey: string } } }) => {
        const k = where.merchantId_idempotencyKey;
        if (!k) return null;
        return intentsByMerchantKey.get(`${k.merchantId}:${k.idempotencyKey}`) ?? null;
      },
      create: async ({ data }: { data: { merchantId: string; idempotencyKey: string; amount: number; currency: string; status: string; clientSecret: string; captureMethod: string; metadata?: unknown } }) => {
        const id = `pi_test_${++intentCounter}`;
        const created = { id, ...data };
        intentsByMerchantKey.set(`${data.merchantId}:${data.idempotencyKey}`, created);
        return created;
      },
    },
    customer: { findFirst: async () => null },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({
      paymentIntent: {
        create: async ({ data }: { data: { merchantId: string; idempotencyKey: string; amount: number; currency: string; status: string; clientSecret: string; captureMethod: string; metadata?: unknown } }) => {
          const id = `pi_test_${++intentCounter}`;
          const created = { id, ...data };
          intentsByMerchantKey.set(`${data.merchantId}:${data.idempotencyKey}`, created);
          return created;
        },
      },
      event: { create: async ({ data }: { data: unknown }) => ({ id: 'evt_x', ...(data as object) }) },
      webhook: { findMany: async () => [] },
      webhookDelivery: { createMany: async () => ({ count: 0 }) },
    }),
  },
}));

// Bypass API-key + rate-limit middleware so we can test the route in isolation.
jest.mock('../../src/middleware/auth', () => ({
  requireApiKey: (req: { merchantId?: string; scopes?: string[] }, _res: unknown, next: () => void) => {
    req.merchantId = 'merchant_test_1';
    req.scopes = ['payments:write', 'refunds:write'];
    next();
  },
  requireScope: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../src/middleware/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// The events publisher needs a working `publishEvent` that doesn't touch real Redis.
jest.mock('../../src/services/events', () => ({
  publishEvent: jest.fn(async () => ({ id: 'evt_test' })),
  enqueueDueDeliveries: jest.fn(async () => 0),
  webhookQueue: { add: jest.fn(async () => undefined) },
  WEBHOOK_QUEUE_NAME: 'webhook-deliveries',
  nextBackoffMs: () => 1000,
  MAX_WEBHOOK_ATTEMPTS: 8,
}));

// Mock razorpay outbound calls.
const realFetch = global.fetch;
beforeAll(() => {
  global.fetch = jest.fn(async () => new Response(JSON.stringify({ id: 'order_xx' }), { status: 200 })) as typeof fetch;
});
afterAll(() => {
  global.fetch = realFetch;
});

import express from 'express';
import request from 'supertest';
import { paymentIntentRouter } from '../../src/routes/paymentIntents';
import { errorHandler } from '../../src/middleware/error';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/payment_intents', paymentIntentRouter);
  app.use(errorHandler);
  return app;
}

describe('POST /v1/payment_intents — idempotency', () => {
  beforeEach(() => {
    intentsByMerchantKey.clear();
    intentCounter = 0;
  });

  it('first request returns 201 and a new intent', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/v1/payment_intents')
      .set('Idempotency-Key', 'idem_1')
      .send({ amount: 50_000, currency: 'INR' });
    expect(res.status).toBe(201);
    expect(res.body.paymentIntent.id).toMatch(/^pi_test_/);
  });

  it('replaying with the same Idempotency-Key returns 200 + same id', async () => {
    const app = buildApp();
    const first = await request(app)
      .post('/v1/payment_intents')
      .set('Idempotency-Key', 'idem_replay')
      .send({ amount: 50_000, currency: 'INR' });
    expect(first.status).toBe(201);
    const firstId = first.body.paymentIntent.id;

    const second = await request(app)
      .post('/v1/payment_intents')
      .set('Idempotency-Key', 'idem_replay')
      .send({ amount: 99_999, currency: 'INR' }); // different body — must be ignored
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.paymentIntent.id).toBe(firstId);
  });

  it('missing Idempotency-Key returns 400 validation_error', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/v1/payment_intents')
      .send({ amount: 50_000, currency: 'INR' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });
});
