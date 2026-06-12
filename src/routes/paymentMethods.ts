import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireApiKey, requireScope } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { NotFoundError, ValidationError } from '../utils/errors';

export const paymentMethodRouter = Router();

paymentMethodRouter.use(requireApiKey, rateLimit());

const attachSchema = z.object({
  customerId: z.string().uuid(),
  tokenId: z.string().min(1),      // from Razorpay vault
  type: z.enum(['CARD', 'UPI', 'NETBANKING', 'WALLET', 'BANK_ACCOUNT']),
  // Card metadata from Razorpay token response
  brand: z.string().optional(),
  last4: z.string().length(4).optional(),
  expMonth: z.number().int().min(1).max(12).optional(),
  expYear: z.number().int().min(2024).optional(),
  isInternational: z.boolean().default(false),
  fingerprint: z.string().optional(),
});

// POST /v1/payment_methods
paymentMethodRouter.post('/', requireScope('tokenize'), async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = attachSchema.parse(req.body);

    // Verify customer belongs to this merchant
    const customer = await prisma.customer.findFirst({
      where: { id: data.customerId, merchantId: req.merchantId },
    });
    if (!customer) throw new NotFoundError('Customer');

    // Check for duplicate token
    const existing = await prisma.paymentMethod.findUnique({
      where: { tokenId: data.tokenId },
    });
    if (existing) {
      // Idempotent — return existing
      if (existing.customerId === data.customerId) {
        res.status(200).json({ paymentMethod: existing });
        return;
      }
      throw new ValidationError('Payment token is already attached');
    }

    // Check for duplicate card via fingerprint
    if (data.fingerprint) {
      const duplicate = await prisma.paymentMethod.findFirst({
        where: { customerId: data.customerId, fingerprint: data.fingerprint },
      });
      if (duplicate) {
        throw new ValidationError(
          'This card is already saved for this customer'
        );
      }
    }

    const paymentMethod = await prisma.paymentMethod.create({
      data: {
        customerId: data.customerId,
        type: data.type,
        tokenId: data.tokenId,
        brand: data.brand,
        last4: data.last4,
        expMonth: data.expMonth,
        expYear: data.expYear,
        isInternational: data.isInternational,
        fingerprint: data.fingerprint,
      },
    });

    res.status(201).json({ paymentMethod });
  } catch (err) {
    next(err);
  }
});

// DELETE /v1/payment_methods/:id
paymentMethodRouter.delete('/:id', requireScope('tokenize'), async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    // Verify ownership via customer → merchant chain
    const pm = await prisma.paymentMethod.findFirst({
      where: { id: req.params.id },
      include: { customer: { select: { merchantId: true } } },
    });

    if (!pm || pm.customer.merchantId !== req.merchantId) {
      throw new NotFoundError('Payment method');
    }

    await prisma.paymentMethod.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});
