import { Worker } from 'bullmq';
import { prisma } from '../db';
import { redis } from '../redis';
import { logger } from '../middleware/logger';
import {
  webhookDeliveriesTotal,
  webhookDeliveryDurationSeconds,
} from '../middleware/metrics';
import {
  WEBHOOK_QUEUE_NAME,
  webhookQueue,
  enqueueDueDeliveries,
  nextBackoffMs,
  MAX_WEBHOOK_ATTEMPTS,
} from '../services/events';
import {
  signPayload,
  decryptWebhookSecret,
  WEBHOOK_SIGNATURE_HEADER,
} from '../services/webhooks';

const HTTP_TIMEOUT_MS = 10_000;

interface DeliverJobData {
  deliveryId: string;
}

async function deliverOne(deliveryId: string): Promise<void> {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      event: true,
      webhook: { select: { id: true, url: true, secretHash: true, status: true } },
    },
  });

  if (!delivery) {
    logger.warn({ deliveryId }, 'Delivery row missing — skipping');
    return;
  }
  if (delivery.status === 'DELIVERED') {
    return;
  }
  if (delivery.webhook.status !== 'ACTIVE') {
    logger.info({ deliveryId, webhookId: delivery.webhookId }, 'Webhook not active, skipping');
    return;
  }

  const body = JSON.stringify({
    id: delivery.event.id,
    type: delivery.event.type,
    apiVersion: delivery.event.apiVersion,
    createdAt: delivery.event.createdAt.toISOString(),
    data: delivery.event.payload,
  });

  const secret = decryptWebhookSecret(delivery.webhook.secretHash);
  const signature = signPayload(body, secret);

  let responseCode: number | null = null;
  let responseBody: string | null = null;
  let success = false;
  const attemptStart = Date.now();

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(delivery.webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'PaymentGateway-Webhook/1.0',
          [WEBHOOK_SIGNATURE_HEADER]: signature,
          'X-Payments-Event-Id': delivery.event.id,
          'X-Payments-Delivery-Id': delivery.id,
        },
        body,
        signal: ac.signal,
      });
      responseCode = response.status;
      responseBody = (await response.text()).slice(0, 4096); // cap stored body
      success = response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    responseBody = err instanceof Error ? err.message : String(err);
    success = false;
  }

  const newAttempts = delivery.attempts + 1;
  const elapsedMs = Date.now() - attemptStart;
  webhookDeliveryDurationSeconds.observe(elapsedMs / 1000);
  webhookDeliveriesTotal.inc({
    outcome: success
      ? 'succeeded'
      : newAttempts >= MAX_WEBHOOK_ATTEMPTS
      ? 'failed'
      : 'retrying',
  });
  logger.info(
    {
      deliveryId,
      webhookId: delivery.webhookId,
      eventType: delivery.event.type,
      success,
      responseCode,
      attempts: newAttempts,
      elapsedMs,
    },
    success ? 'Webhook delivered' : 'Webhook delivery failed'
  );

  if (success) {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'DELIVERED',
        attempts: newAttempts,
        lastAttemptAt: new Date(),
        responseCode,
        responseBody,
        nextAttemptAt: null,
      },
    });
    return;
  }

  if (newAttempts >= MAX_WEBHOOK_ATTEMPTS) {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'FAILED',
        attempts: newAttempts,
        lastAttemptAt: new Date(),
        responseCode,
        responseBody,
        nextAttemptAt: null,
      },
    });
    // After 5 consecutive failures, flag the webhook as FAILING
    const recentFailed = await prisma.webhookDelivery.count({
      where: {
        webhookId: delivery.webhookId,
        status: 'FAILED',
        createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
      },
    });
    if (recentFailed >= 5) {
      await prisma.webhook.update({
        where: { id: delivery.webhookId },
        data: { status: 'FAILING' },
      });
    }
    return;
  }

  // Schedule next retry
  const delayMs = nextBackoffMs(newAttempts);
  const nextAttemptAt = new Date(Date.now() + delayMs);
  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      attempts: newAttempts,
      lastAttemptAt: new Date(),
      responseCode,
      responseBody,
      nextAttemptAt,
    },
  });

  await webhookQueue.add(
    'deliver',
    { deliveryId },
    { delay: delayMs, jobId: `${deliveryId}:${newAttempts}` }
  );
}

export function startWebhookWorker(): Worker<DeliverJobData> {
  const worker = new Worker<DeliverJobData>(
    WEBHOOK_QUEUE_NAME,
    async (job) => deliverOne(job.data.deliveryId),
    {
      connection: redis.duplicate({ maxRetriesPerRequest: null }) as any,
      concurrency: Number(process.env.WEBHOOK_WORKER_CONCURRENCY ?? 8),
    }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'BullMQ job failed');
  });

  // Periodic recovery sweep — picks up deliveries scheduled while the worker
  // was down (using nextAttemptAt as the source of truth).
  const sweepIntervalMs = 60_000;
  const sweepTimer = setInterval(() => {
    enqueueDueDeliveries(prisma).catch((err) => {
      logger.error({ err }, 'Recovery sweep failed');
    });
  }, sweepIntervalMs);
  // Allow process to exit cleanly during graceful shutdown
  sweepTimer.unref();

  logger.info({ queue: WEBHOOK_QUEUE_NAME }, 'Webhook worker started');
  return worker;
}

// Allow `node dist/workers/webhookWorker.js` as a standalone entrypoint
if (require.main === module) {
  const worker = startWebhookWorker();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Webhook worker shutting down');
    await worker.close();
    await prisma.$disconnect();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
