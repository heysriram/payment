import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireJwt, requireTotpVerified } from '../middleware/jwtAuth';
import { ValidationError } from '../utils/errors';

export const eventRouter = Router();

eventRouter.use(requireJwt, requireTotpVerified);

// GET /v1/events — replay / inspect events for the authenticated merchant.
// Cursor-paginated, filterable by type and time range.
eventRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const querySchema = z.object({
      type: z.string().optional(),
      since: z.coerce.date().optional(),
      until: z.coerce.date().optional(),
      cursor: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    });
    const q = querySchema.parse(req.query);

    if (q.since && q.until && q.since > q.until) {
      throw new ValidationError('since must be <= until');
    }

    const events = await prisma.event.findMany({
      where: {
        merchantId: req.merchantId!,
        ...(q.type ? { type: q.type } : {}),
        ...(q.since || q.until
          ? { createdAt: { ...(q.since && { gte: q.since }), ...(q.until && { lte: q.until }) } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit + 1,
      ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
      select: {
        id: true,
        type: true,
        payload: true,
        apiVersion: true,
        createdAt: true,
      },
    });

    const hasMore = events.length > q.limit;
    const data = hasMore ? events.slice(0, -1) : events;
    res.json({
      data,
      has_more: hasMore,
      next_cursor: hasMore ? data[data.length - 1].id : null,
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/events/:id
eventRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const event = await prisma.event.findFirst({
      where: { id: req.params.id, merchantId: req.merchantId! },
      select: {
        id: true,
        type: true,
        payload: true,
        apiVersion: true,
        createdAt: true,
        deliveries: {
          select: {
            id: true,
            webhookId: true,
            status: true,
            attempts: true,
            lastAttemptAt: true,
            responseCode: true,
          },
        },
      },
    });
    if (!event) {
      res.status(404).json({ error: { code: 'not_found', message: 'Event not found' } });
      return;
    }
    res.json({ event });
  } catch (err) {
    next(err);
  }
});
