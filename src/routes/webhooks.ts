import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireJwt, requireTotpVerified, requireRole } from '../middleware/jwtAuth';
import { generateWebhookSecret } from '../services/webhooks';
import { enqueueDueDeliveries } from '../services/events';
import { NotFoundError, ValidationError } from '../utils/errors';

export const webhookRouter = Router();

webhookRouter.use(requireJwt, requireTotpVerified);

// POST /v1/webhooks/:id/test — emits a synthetic ping event delivered only to this webhook
webhookRouter.post('/:id/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const found = await prisma.webhook.findFirst({
      where: { id: req.params.id, merchantId: req.merchantId! },
    });
    if (!found) throw new NotFoundError('Webhook');

    await prisma.$transaction(async (tx) => {
      const event = await tx.event.create({
        data: {
          merchantId: req.merchantId!,
          type: 'webhook.test',
          payload: { ping: 'pong', sentAt: new Date().toISOString() },
        },
      });
      await tx.webhookDelivery.create({
        data: {
          webhookId: found.id,
          eventId: event.id,
          status: 'PENDING',
          nextAttemptAt: new Date(),
        },
      });
    });
    await enqueueDueDeliveries(prisma);
    res.json({ sent: true });
  } catch (err) {
    next(err);
  }
});

const KNOWN_EVENTS = [
  'payment_intent.created',
  'payment_intent.succeeded',
  'payment_intent.failed',
  'payment_intent.cancelled',
  'refund.created',
  'refund.succeeded',
  'dispute.created',
  'dispute.resolved',
  'payout.paid',
  '*',
] as const;

const createSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(KNOWN_EVENTS)).min(1),
});

const updateSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.enum(KNOWN_EVENTS)).min(1).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
});

// POST /v1/webhooks
webhookRouter.post(
  '/',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = createSchema.parse(req.body);
      const { plaintext, ciphertext } = generateWebhookSecret();

      const webhook = await prisma.webhook.create({
        data: {
          merchantId: req.merchantId!,
          url: data.url,
          events: data.events,
          secretHash: ciphertext,
        },
        select: {
          id: true,
          url: true,
          events: true,
          status: true,
          createdAt: true,
        },
      });

      res.status(201).json({
        webhook,
        secret: plaintext,
        note: 'Save this secret — it will not be shown again. Use it to verify the X-Payments-Signature header.',
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /v1/webhooks
webhookRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await prisma.webhook.findMany({
      where: { merchantId: req.merchantId! },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        url: true,
        events: true,
        status: true,
        createdAt: true,
        _count: { select: { deliveries: true } },
      },
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// PATCH /v1/webhooks/:id
webhookRouter.patch(
  '/:id',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = updateSchema.parse(req.body);
      const found = await prisma.webhook.findFirst({
        where: { id: req.params.id, merchantId: req.merchantId! },
      });
      if (!found) throw new NotFoundError('Webhook');

      const updated = await prisma.webhook.update({
        where: { id: found.id },
        data: {
          url: data.url,
          events: data.events,
          status: data.status,
        },
        select: { id: true, url: true, events: true, status: true, createdAt: true },
      });
      res.json({ webhook: updated });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /v1/webhooks/:id
webhookRouter.delete(
  '/:id',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const found = await prisma.webhook.findFirst({
        where: { id: req.params.id, merchantId: req.merchantId! },
      });
      if (!found) throw new NotFoundError('Webhook');
      await prisma.webhook.delete({ where: { id: found.id } });
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  }
);

// GET /v1/webhooks/:id/deliveries — per-webhook delivery log
webhookRouter.get('/:id/deliveries', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const found = await prisma.webhook.findFirst({
      where: { id: req.params.id, merchantId: req.merchantId! },
    });
    if (!found) throw new NotFoundError('Webhook');

    const deliveries = await prisma.webhookDelivery.findMany({
      where: { webhookId: found.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        event: { select: { id: true, type: true, createdAt: true } },
      },
    });
    res.json({ data: deliveries });
  } catch (err) {
    next(err);
  }
});

// POST /v1/webhooks/:id/deliveries/:deliveryId/retry — manual retry from dashboard
webhookRouter.post(
  '/:id/deliveries/:deliveryId/retry',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const delivery = await prisma.webhookDelivery.findFirst({
        where: {
          id: req.params.deliveryId,
          webhookId: req.params.id,
          webhook: { merchantId: req.merchantId! },
        },
      });
      if (!delivery) throw new NotFoundError('Webhook delivery');
      if (delivery.status === 'DELIVERED') {
        throw new ValidationError('Delivery already succeeded');
      }

      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'PENDING', nextAttemptAt: new Date() },
      });

      await enqueueDueDeliveries(prisma, delivery.eventId);
      res.json({ retried: true });
    } catch (err) {
      next(err);
    }
  }
);
