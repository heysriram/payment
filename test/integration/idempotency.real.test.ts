/**
 * Real end-to-end idempotency test backed by Testcontainers.
 *
 * - Boots Postgres + Redis in Docker
 * - Runs the actual Prisma migrations
 * - Registers a merchant and exercises the public POST /payment_intents path
 *   through the real Express stack (helmet, hpp, error handler, all of it)
 *
 * Fast runners (no Docker) should rely on the unit-mode mock test in
 * test/unit/idempotency.test.ts. This suite is opt-in via `npm run test:integration`.
 */

import path from 'node:path';
import {
  setupTestEnv,
  teardownTestEnv,
  TestEnv,
} from '../helpers/testcontainersEnv';

let env: TestEnv | undefined;

// Containers + migrations can take a minute on a cold cache.
jest.setTimeout(180_000);

beforeAll(async () => {
  env = await setupTestEnv();
});

afterAll(async () => {
  // Disconnect Prisma + Redis before stopping the containers, otherwise
  // ioredis spams reconnect attempts that keep the process alive.
  try {
    const { prisma } = await import('../../src/db');
    await prisma.$disconnect();
  } catch {
    // ignore — module may not have been loaded if tests bailed early
  }
  try {
    const { redis } = await import('../../src/redis');
    redis.disconnect();
  } catch {
    // ignore
  }
  await teardownTestEnv(env);
});

describe('payment intents — real Postgres + Redis', () => {
  it('replaying with the same Idempotency-Key returns the same intent', async () => {
    // Lazy-import after env vars are set so config.ts validates against the
    // testcontainers DSNs.
    const request = (await import('supertest')).default;
    const { createApp } = await import('../../src/app');
    const app = createApp();

    // Register a merchant. The route returns a test secret key we can use
    // for the API-key paths.
    const reg = await request(app)
      .post('/api/v1/merchants/register')
      .send({
        name: 'Testcontainers Store',
        legalName: 'TC Store Pvt Ltd',
        email: `merchant+${Date.now()}@tc.test`,
        password: 'TestcontainersPass123!',
      });

    expect(reg.status).toBe(201);
    const secret = reg.body.apiKeys.test.secretKey as string;
    expect(secret).toMatch(/^sk_test_/);

    const idem = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const body = { amount: 50_000, currency: 'INR' };

    const first = await request(app)
      .post('/api/v1/payment_intents')
      .set('Authorization', `Bearer ${secret}`)
      .set('Idempotency-Key', idem)
      .send(body);
    expect(first.status).toBe(201);
    const firstId = first.body.paymentIntent.id;
    expect(firstId).toMatch(/^[0-9a-f]{8}-/); // uuid

    const replay = await request(app)
      .post('/api/v1/payment_intents')
      .set('Authorization', `Bearer ${secret}`)
      .set('Idempotency-Key', idem)
      .send({ ...body, amount: 999_999 }); // different body — must be ignored
    expect(replay.status).toBe(200);
    expect(replay.body.idempotent).toBe(true);
    expect(replay.body.paymentIntent.id).toBe(firstId);
    expect(replay.body.paymentIntent.amount).toBe(50_000);
  });

  it('two different Idempotency-Keys create two distinct intents', async () => {
    const request = (await import('supertest')).default;
    const { createApp } = await import('../../src/app');
    const app = createApp();

    const reg = await request(app)
      .post('/api/v1/merchants/register')
      .send({
        name: 'TC Two-key Store',
        legalName: 'TC Two-key Store Pvt Ltd',
        email: `merchant+two+${Date.now()}@tc.test`,
        password: 'TestcontainersPass123!',
      });
    const secret = reg.body.apiKeys.test.secretKey as string;

    const a = await request(app)
      .post('/api/v1/payment_intents')
      .set('Authorization', `Bearer ${secret}`)
      .set('Idempotency-Key', `idem_a_${Date.now()}`)
      .send({ amount: 12_345 });
    const b = await request(app)
      .post('/api/v1/payment_intents')
      .set('Authorization', `Bearer ${secret}`)
      .set('Idempotency-Key', `idem_b_${Date.now()}`)
      .send({ amount: 12_345 });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.paymentIntent.id).not.toBe(b.body.paymentIntent.id);
  });

  it('the events table is append-only at the database level', async () => {
    const { prisma } = await import('../../src/db');

    // Find any merchant we created above
    const merchant = await prisma.merchant.findFirst();
    if (!merchant) throw new Error('expected at least one merchant');

    const event = await prisma.event.create({
      data: {
        merchantId: merchant.id,
        type: 'webhook.test',
        payload: { hello: 'world' },
      },
    });

    await expect(
      prisma.event.update({
        where: { id: event.id },
        data: { type: 'something.else' },
      })
    ).rejects.toThrow(/append-only/i);

    await expect(
      prisma.event.delete({ where: { id: event.id } })
    ).rejects.toThrow(/append-only/i);
  });
});

// Silence TypeScript for the unused path import (kept for convenience if
// future tests need to resolve fixtures relative to the workspace).
void path;
