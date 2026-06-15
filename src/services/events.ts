import { Prisma, PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { redis } from '../redis';
import { logger } from '../middleware/logger';

type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export const WEBHOOK_QUEUE_NAME = 'webhook-deliveries';

/**
 * Single shared queue. The connection is reused from the existing ioredis client
 * (BullMQ requires `maxRetriesPerRequest: null`, so we hand it a duplicated
 * connection configured for that).
 */
export const webhookQueue = new Queue(WEBHOOK_QUEUE_NAME, {
  connection: redis.duplicate({ maxRetriesPerRequest: null }) as any,
  defaultJobOptions: {
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
    attempts: 1, // we drive retries via WebhookDelivery.attempts + nextAttemptAt
  },
});

/** Stripe-style event type registry — keep in sync with `openapi.yaml`. */
export type EventType =
  | 'payment_intent.created'
  | 'payment_intent.succeeded'
  | 'payment_intent.failed'
  | 'payment_intent.cancelled'
  | 'refund.created'
  | 'refund.succeeded'
  | 'dispute.created'
  | 'dispute.resolved'
  | 'payout.paid';

export interface PublishOpts {
  merchantId: string;
  type: EventType;
  payload: Record<string, unknown>;
}

/**
 * Persist an event to the append-only `events` table and fan-out to every
 * matching active webhook for the merchant. Designed to be called inside a
 * Prisma transaction so the event is atomic with its source record.
 *
 * If a `tx` is not provided, a non-transactional publish is used — only OK for
 * events that are never written from inside a `$transaction()`.
 */
export async function publishEvent(
  tx: TxClient,
  opts: PublishOpts
): Promise<{ id: string }> {
  const event = await tx.event.create({
    data: {
      merchantId: opts.merchantId,
      type: opts.type,
      payload: opts.payload as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  // Find subscribed, active webhooks. We do this inside the transaction so
  // a webhook added one millisecond ago will reliably see the event.
  const webhooks = await tx.webhook.findMany({
    where: {
      merchantId: opts.merchantId,
      status: 'ACTIVE',
    },
    select: { id: true, events: true },
  });

  const subscribed = webhooks.filter((w) => {
    const list = Array.isArray(w.events) ? (w.events as unknown[]) : [];
    return list.includes(opts.type) || list.includes('*');
  });

  if (subscribed.length === 0) return event;

  await tx.webhookDelivery.createMany({
    data: subscribed.map((w) => ({
      webhookId: w.id,
      eventId: event.id,
      status: 'PENDING' as const,
      nextAttemptAt: new Date(),
    })),
  });

  // Enqueue jobs AFTER the transaction commits — done by the caller via
  // `enqueuePendingDeliveries(deliveryIds)`. We can't await the queue inside
  // a Prisma transaction or we risk dispatching a delivery for a row that
  // doesn't yet exist.
  return event;
}

/**
 * Fetches deliveries that are PENDING and due, and pushes them onto the queue.
 * Safe to call after the source transaction commits, or as a recovery sweep.
 */
export async function enqueueDueDeliveries(prisma: PrismaClient, eventId?: string): Promise<number> {
  const deliveries = await prisma.webhookDelivery.findMany({
    where: {
      status: 'PENDING',
      ...(eventId ? { eventId } : {}),
      OR: [
        { nextAttemptAt: { lte: new Date() } },
        { nextAttemptAt: null },
      ],
    },
    select: { id: true },
    take: 1000,
  });

  for (const d of deliveries) {
    await webhookQueue.add(
      'deliver',
      { deliveryId: d.id },
      { jobId: d.id }
    );
  }

  if (deliveries.length > 0) {
    logger.debug({ count: deliveries.length, eventId }, 'Enqueued webhook deliveries');
  }
  return deliveries.length;
}

/** BullMQ-style exponential backoff schedule (8 attempts over ~3 days). */
export function nextBackoffMs(attempts: number): number {
  // 1m, 5m, 30m, 2h, 5h, 10h, 18h, 24h
  const schedule = [60, 5 * 60, 30 * 60, 2 * 3600, 5 * 3600, 10 * 3600, 18 * 3600, 24 * 3600];
  const idx = Math.min(attempts, schedule.length - 1);
  // Add 0..10% jitter to avoid thundering herd
  const base = schedule[idx] * 1000;
  return base + Math.floor(Math.random() * base * 0.1);
}

export const MAX_WEBHOOK_ATTEMPTS = 8;
