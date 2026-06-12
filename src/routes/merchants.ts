import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { hashSecret } from '../utils/crypto';
import { ConflictError, ValidationError, NotFoundError } from '../utils/errors';
import { requireJwt, requireTotpVerified } from '../middleware/jwtAuth';
import { generateApiKey } from '../services/apiKey';
import { getAvailableBalance, postSettlement, postRefund, postDisputeOpened, postDisputeWon } from '../services/ledger';
import crypto from 'crypto';
import { redis } from '../redis';

export const merchantRouter = Router();

const registerSchema = z.object({
  name: z.string().min(2).max(100),
  legalName: z.string().min(2).max(200),
  gst: z.string()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/)
    .or(z.literal(''))
    .transform((val) => val === '' ? undefined : val)
    .optional(),
  pan: z.string()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/)
    .or(z.literal(''))
    .transform((val) => val === '' ? undefined : val)
    .optional(),
  email: z.string().email(),
  password: z.string().min(12),
});

// POST /v1/merchants/register
merchantRouter.post('/register', async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = registerSchema.parse(req.body);

    // Check email not already taken
    const existingUser = await prisma.user.findUnique({
      where: { email: data.email },
    });
    if (existingUser) {
      throw new ConflictError('Email already registered');
    }

    // Get default fee plan
    const feePlan = await prisma.feePlan.findFirst({
      where: { name: 'standard' },
    });
    if (!feePlan) {
      throw new Error('No default fee plan found — run the seed first');
    }

    const passwordHash = await hashSecret(data.password);

    // Create merchant + user + link in one transaction
    const result = await prisma.$transaction(async (tx) => {
      const merchant = await tx.merchant.create({
        data: {
          name: data.name,
          legalName: data.legalName,
          gst: data.gst,
          pan: data.pan,
          status: 'PENDING',
          feePlanId: feePlan.id,
        },
      });

      const user = await tx.user.create({
        data: {
          email: data.email,
          passwordHash,
        },
      });

      await tx.merchantUser.create({
        data: {
          merchantId: merchant.id,
          userId: user.id,
          role: 'OWNER',
        },
      });

      return { merchant, user };
    });

    // Issue test API keys
    const { fullKey: testSecretKey } = await generateApiKey(
      result.merchant.id,
      'TEST',
      ['payments:write', 'payments:read', 'refunds:write', 'customers:write', 'customers:read'],
      true
    );

    const { fullKey: testPublicKey } = await generateApiKey(
      result.merchant.id,
      'TEST',
      ['tokenize'],
      false
    );

    res.status(201).json({
      merchant: {
        id: result.merchant.id,
        name: result.merchant.name,
        status: result.merchant.status,
      },
      apiKeys: {
        test: {
          secretKey: testSecretKey,
          publicKey: testPublicKey,
        },
        note: 'Save these — the secret key will not be shown again.',
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/merchants/me
merchantRouter.get(
  '/me',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const merchant = await prisma.merchant.findUnique({
        where: { id: req.merchantId },
        select: {
          id: true,
          name: true,
          legalName: true,
          gst: true,
          status: true,
          createdAt: true,
          feePlan: {
            select: {
              name: true,
              percentBps: true,
              fixedPaise: true,
            },
          },
        },
      });
      res.json({ merchant });
    } catch (err) {
      next(err);
    }
  }
);

// GET /v1/merchants/balance
merchantRouter.get(
  '/balance',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const available = await getAvailableBalance(req.merchantId!, 'INR');
      const pendingBalanceRaw = await prisma.$queryRaw<{ balance: bigint }[]>`
        SELECT COALESCE(SUM(delta), 0) AS balance
        FROM ledger
        WHERE "merchantId" = ${req.merchantId!}
          AND currency = 'INR'
          AND account = 'PENDING'
      `;
      const pending = Number(pendingBalanceRaw[0].balance);
      res.json({ balance: { available, pending } });
    } catch (err) {
      next(err);
    }
  }
);

// GET /v1/merchants/payment-intents
merchantRouter.get(
  '/payment-intents',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const intents = await prisma.paymentIntent.findMany({
        where: { merchantId: req.merchantId! },
        orderBy: { createdAt: 'desc' },
        include: {
          customer: {
            select: {
              name: true,
              email: true,
            },
          },
          paymentMethod: {
            select: {
              type: true,
              brand: true,
              last4: true,
            },
          },
        },
      });
      res.json({ intents });
    } catch (err) {
      next(err);
    }
  }
);

// GET /v1/merchants/transactions
merchantRouter.get(
  '/transactions',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transactions = await prisma.transaction.findMany({
        where: { merchantId: req.merchantId! },
        orderBy: { occurredAt: 'desc' },
        include: {
          paymentIntent: {
            select: {
              currency: true,
              amount: true,
            },
          },
        },
      });
      res.json({ transactions });
    } catch (err) {
      next(err);
    }
  }
);

// POST /v1/merchants/payment-intents/:id/refund — dashboard route for merchant refunds
merchantRouter.post(
  '/payment-intents/:id/refund',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { amount, reason } = z.object({
        amount: z.number().int().positive().optional(),
        reason: z.string().optional(),
      }).parse(req.body);

      const intent = await prisma.paymentIntent.findFirst({
        where: { id: req.params.id, merchantId: req.merchantId! },
      });

      if (!intent) throw new NotFoundError('Payment intent');
      if (intent.status !== 'SUCCEEDED') {
        throw new ValidationError(`Cannot refund payment intent in status: ${intent.status}`);
      }

      const captureTxn = await prisma.transaction.findFirst({
        where: { paymentIntentId: intent.id, type: 'CAPTURE', status: 'SUCCEEDED' },
      });
      if (!captureTxn) throw new NotFoundError('Capture transaction');

      // Calculate total already refunded
      const refunds = await prisma.refund.findMany({
        where: { transactionId: captureTxn.id, status: 'SUCCEEDED' },
      });
      const totalRefunded = refunds.reduce((sum, r) => sum + r.amount, 0);
      const maxRefundable = intent.amount - totalRefunded;

      const refundAmount = amount ?? maxRefundable;
      if (refundAmount <= 0) {
        throw new ValidationError('No refundable amount remaining or invalid refund amount');
      }
      if (refundAmount > maxRefundable) {
        throw new ValidationError(`Refund amount exceeds maximum remaining refundable amount: ${maxRefundable}`);
      }

      const gatewayRefundId = `rfnd_${crypto.randomBytes(8).toString('hex')}`;
      const refund = await prisma.$transaction(async (tx) => {
        const newRefund = await tx.refund.create({
          data: {
            transactionId: captureTxn.id,
            amount: refundAmount,
            reason: reason || 'Merchant dashboard requested refund',
            status: 'SUCCEEDED',
            gatewayRefundId,
          },
        });

        await tx.transaction.create({
          data: {
            paymentIntentId: intent.id,
            merchantId: intent.merchantId,
            type: 'REFUND',
            amount: refundAmount,
            status: 'SUCCEEDED',
            gateway: 'RAZORPAY',
            gatewayTxnId: gatewayRefundId,
          },
        });

        // Update Ledger
        await postRefund(tx, intent.merchantId, newRefund.id, refundAmount, intent.currency);

        return newRefund;
      });

      res.json({ refund });
    } catch (err) {
      next(err);
    }
  }
);

// POST /v1/merchants/settle — clear PENDING balance to AVAILABLE
merchantRouter.post(
  '/settle',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Get pending balance
      const pendingBalanceRaw = await prisma.$queryRaw<{ balance: bigint }[]>`
        SELECT COALESCE(SUM(delta), 0) AS balance
        FROM ledger
        WHERE "merchantId" = ${req.merchantId!}
          AND currency = 'INR'
          AND account = 'PENDING'
      `;
      const pendingAmount = Number(pendingBalanceRaw[0].balance);

      if (pendingAmount <= 0) {
        throw new ValidationError('No pending balance to settle');
      }

      const payout = await prisma.$transaction(async (tx) => {
        const newPayout = await tx.payout.create({
          data: {
            merchantId: req.merchantId!,
            amount: pendingAmount,
            currency: 'INR',
            status: 'PAID',
            bankRef: `settle_${crypto.randomBytes(6).toString('hex')}`,
            scheduledFor: new Date(),
            paidAt: new Date(),
          },
        });

        // Run postSettlement
        await postSettlement(tx, req.merchantId!, newPayout.id, pendingAmount, 'INR');

        return newPayout;
      });

      res.json({ payout });
    } catch (err) {
      next(err);
    }
  }
);

// POST /v1/merchants/payout — withdraw AVAILABLE balance to external bank account
merchantRouter.post(
  '/payout',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { amount } = z.object({
        amount: z.number().int().positive(),
      }).parse(req.body);

      const available = await getAvailableBalance(req.merchantId!, 'INR');
      if (amount > available) {
        throw new ValidationError(`Insufficient available balance (Available: ${available / 100}, Requested: ${amount / 100})`);
      }

      const payout = await prisma.$transaction(async (tx) => {
        const newPayout = await tx.payout.create({
          data: {
            merchantId: req.merchantId!,
            amount: amount,
            currency: 'INR',
            status: 'PAID',
            bankRef: `payout_${crypto.randomBytes(6).toString('hex')}`,
            scheduledFor: new Date(),
            paidAt: new Date(),
          },
        });

        // Debit AVAILABLE balance, credit PROCESSOR
        await tx.ledgerEntry.createMany({
          data: [
            {
              merchantId: req.merchantId!,
              account: 'AVAILABLE',
              delta: -amount,
              currency: 'INR',
              refType: 'PAYOUT',
              refId: newPayout.id,
            },
            {
              merchantId: req.merchantId!,
              account: 'PROCESSOR',
              delta: amount,
              currency: 'INR',
              refType: 'PAYOUT',
              refId: newPayout.id,
            }
          ]
        });

        return newPayout;
      });

      res.json({ payout });
    } catch (err) {
      next(err);
    }
  }
);

// POST /v1/merchants/payment-intents/:id/dispute — simulate a chargeback open
merchantRouter.post(
  '/payment-intents/:id/dispute',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const intent = await prisma.paymentIntent.findFirst({
        where: { id: req.params.id, merchantId: req.merchantId! },
      });

      if (!intent) throw new NotFoundError('Payment intent');
      if (intent.status !== 'SUCCEEDED') {
        throw new ValidationError('Can only dispute successful payments');
      }

      const captureTxn = await prisma.transaction.findFirst({
        where: { paymentIntentId: intent.id, type: 'CAPTURE', status: 'SUCCEEDED' },
      });
      if (!captureTxn) throw new NotFoundError('Capture transaction');

      // Check if dispute already exists for this transaction
      const existingDispute = await prisma.dispute.findFirst({
        where: { transactionId: captureTxn.id },
      });
      if (existingDispute) {
        throw new ValidationError('A dispute already exists for this transaction');
      }

      const dispute = await prisma.$transaction(async (tx) => {
        const newDispute = await tx.dispute.create({
          data: {
            transactionId: captureTxn.id,
            amount: intent.amount,
            reasonCode: 'chargeback_fraud_simulated',
            status: 'NEEDS_RESPONSE',
            dueBy: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
          },
        });

        // Debit AVAILABLE, credit DISPUTES
        await postDisputeOpened(tx, intent.merchantId, newDispute.id, intent.amount, intent.currency);

        return newDispute;
      });

      res.json({ dispute });
    } catch (err) {
      next(err);
    }
  }
);

// POST /v1/merchants/disputes/:id/resolve — resolve a dispute as WON or LOST
merchantRouter.post(
  '/disputes/:id/resolve',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status } = z.object({
        status: z.enum(['WON', 'LOST']),
      }).parse(req.body);

      const dispute = await prisma.dispute.findUnique({
        where: { id: req.params.id },
        include: {
          transaction: {
            include: { paymentIntent: true },
          },
        },
      });

      if (!dispute) throw new NotFoundError('Dispute');
      if (dispute.status !== 'NEEDS_RESPONSE') {
        throw new ValidationError(`Dispute is already resolved as: ${dispute.status}`);
      }

      const resolvedDispute = await prisma.$transaction(async (tx) => {
        const updatedDispute = await tx.dispute.update({
          where: { id: dispute.id },
          data: { status: status as any },
        });

        if (status === 'WON') {
          // Restore funds: Debit DISPUTES, credit AVAILABLE
          await postDisputeWon(
            tx,
            dispute.transaction.merchantId,
            dispute.id,
            dispute.amount,
            dispute.transaction.paymentIntent.currency
          );
        } else {
          // If LOST, the funds remain debited from AVAILABLE, and are settled in disputes ledger.
          await tx.ledgerEntry.createMany({
            data: [
              {
                merchantId: dispute.transaction.merchantId,
                account: 'DISPUTES',
                delta: -dispute.amount,
                currency: dispute.transaction.paymentIntent.currency,
                refType: 'DISPUTE_LOST',
                refId: dispute.id,
              },
              {
                merchantId: dispute.transaction.merchantId,
                account: 'PROCESSOR',
                delta: dispute.amount,
                currency: dispute.transaction.paymentIntent.currency,
                refType: 'DISPUTE_LOST',
                refId: dispute.id,
              }
            ]
          });
        }

        return updatedDispute;
      });

      res.json({ dispute: resolvedDispute });
    } catch (err) {
      next(err);
    }
  }
);

// GET /v1/merchants/disputes — list disputes for the merchant
merchantRouter.get(
  '/disputes',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const disputes = await prisma.dispute.findMany({
        where: {
          transaction: {
            merchantId: req.merchantId!,
          },
        },
        orderBy: { createdAt: 'desc' },
        include: {
          transaction: {
            include: {
              paymentIntent: {
                select: {
                  id: true,
                  amount: true,
                  currency: true,
                  customer: {
                    select: {
                      name: true,
                    },
                  },
                },
              },
            },
          },
        },
      });
      res.json({ disputes });
    } catch (err) {
      next(err);
    }
  }
);

// GET /v1/merchants/wallets — get all customers with their wallet balances
merchantRouter.get(
  '/wallets',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customers = await prisma.customer.findMany({
        where: { merchantId: req.merchantId! },
        select: { id: true, name: true, email: true },
        orderBy: { name: 'asc' },
      });

      const wallets = await Promise.all(
        customers.map(async (c) => {
          const balanceStr = await redis.get(`wallet:balance:${c.id}`);
          const balance = balanceStr ? parseInt(balanceStr, 10) : 0;
          return {
            id: c.id,
            name: c.name,
            email: c.email,
            balance,
          };
        })
      );

      res.json({ wallets });
    } catch (err) {
      next(err);
    }
  }
);

// GET /v1/merchants/customers/:customerId/wallet-transactions — get customer wallet transactions
merchantRouter.get(
  '/customers/:customerId/wallet-transactions',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = req.params.customerId;

      // Verify customer belongs to this merchant
      const customer = await prisma.customer.findFirst({
        where: { id: customerId, merchantId: req.merchantId! },
      });
      if (!customer) throw new NotFoundError('Customer');

      const txnsRaw = await redis.lrange(`wallet:transactions:${customerId}`, 0, -1);
      const transactions = txnsRaw.map((t) => JSON.parse(t));

      res.json({ transactions });
    } catch (err) {
      next(err);
    }
  }
);

