import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { hashSecret } from '../utils/crypto';
import { ConflictError, ValidationError, NotFoundError } from '../utils/errors';
import { requireJwt, requireTotpVerified } from '../middleware/jwtAuth';
import { generateApiKey } from '../services/apiKey';
import { calculateFee } from '../services/fees';
import { getAvailableBalance, postSettlement, postRefund, postDisputeOpened, postDisputeWon, postCapture } from '../services/ledger';
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

// POST /v1/merchants/payment-intents — first-party dashboard route to create a payment intent
merchantRouter.post(
  '/payment-intents',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { amount, currency, customerId, captureMethod, metadata } = z.object({
        amount: z.number().int().min(100),
        currency: z.string().length(3).default('INR'),
        customerId: z.string().uuid().optional(),
        captureMethod: z.enum(['AUTOMATIC', 'MANUAL']).default('AUTOMATIC'),
        metadata: z.record(z.any()).optional(),
      }).parse(req.body);

      // Validate the referenced customer simply exists. We deliberately do
      // NOT require ownership: the dashboard's customer dropdown shows every
      // customer in the database (own + guests + customers from other
      // merchants), so a merchant may invoice anyone. If the customer isn't
      // already related to this merchant, paying the resulting intent will
      // automatically surface them as a "guest" via the existing
      // `/merchants/customers` query (owned OR has-paid-us).
      if (customerId) {
        const customer = await prisma.customer.findUnique({
          where: { id: customerId },
          select: { id: true },
        });
        if (!customer) throw new NotFoundError('Customer');
      }

      const clientSecret = crypto.randomBytes(32).toString('base64url');
      const clientSecretHash = crypto.createHash('sha256').update(clientSecret).digest('hex');

      const intent = await prisma.paymentIntent.create({
        data: {
          merchantId: req.merchantId!,
          customerId,
          amount,
          currency: currency.toUpperCase(),
          status: 'REQUIRES_PM',
          clientSecret: clientSecretHash,
          idempotencyKey: `dash_${crypto.randomBytes(12).toString('hex')}`,
          captureMethod,
          metadata,
        },
      });

      res.status(201).json({ paymentIntent: { ...intent, clientSecret } });
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
              id: true,
              currency: true,
              amount: true,
              metadata: true,
              customer: {
                select: { id: true, name: true, email: true },
              },
            },
          },
        },
      });

      // Fetch other ledger debit events like customer wallet withdrawals and requested payouts
      const ledgerDebitEntries = await prisma.ledgerEntry.findMany({
        where: {
          merchantId: req.merchantId!,
          refType: { in: ['WITHDRAWAL', 'PAYOUT'] },
          account: 'AVAILABLE',
        },
        orderBy: { postedAt: 'desc' },
      });

      const mappedDebitTxns = ledgerDebitEntries.map((e) => ({
        id: e.refId,
        paymentIntentId: '',
        merchantId: e.merchantId,
        type: e.refType as any, // 'WITHDRAWAL' or 'PAYOUT'
        amount: Math.abs(e.delta),
        status: 'SUCCEEDED' as any,
        gateway: e.refType === 'WITHDRAWAL' ? 'WALLET' : 'BANK',
        gatewayTxnId: e.refId,
        processorResponse: null,
        occurredAt: e.postedAt,
        paymentIntent: {
          id: '',
          currency: e.currency,
          amount: Math.abs(e.delta),
          metadata: { type: e.refType.toLowerCase() },
          customer: null,
        },
      }));

      const allTxns = [
        ...transactions,
        ...mappedDebitTxns,
      ].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

      res.json({ transactions: allTxns });
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

// POST /v1/merchants/payment-intents/:id/capture — manual capture of an
// authorised intent (only valid for captureMethod=MANUAL intents that are in
// PROCESSING). Mirrors POST /v1/payment_intents/:id/capture but uses the
// dashboard JWT instead of an API key.
merchantRouter.post(
  '/payment-intents/:id/capture',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const intent = await prisma.paymentIntent.findFirst({
        where: { id: req.params.id, merchantId: req.merchantId! },
        include: {
          merchant: { include: { feePlan: true } },
          paymentMethod: { select: { isInternational: true } },
        },
      });

      if (!intent) throw new NotFoundError('Payment intent');
      if (intent.captureMethod !== 'MANUAL') {
        throw new ValidationError('This intent uses automatic capture');
      }
      if (intent.status !== 'PROCESSING') {
        throw new ValidationError(`Cannot capture intent in status: ${intent.status}`);
      }

      const authTxn = await prisma.transaction.findFirst({
        where: { paymentIntentId: intent.id, type: 'AUTH', status: 'SUCCEEDED' },
      });
      if (!authTxn) throw new NotFoundError('Auth transaction');
      if (!intent.paymentMethod) throw new NotFoundError('Payment method');

      const feeAmount = calculateFee(
        intent.amount,
        intent.merchant.feePlan,
        intent.paymentMethod.isInternational
      );

      await prisma.$transaction(async (tx) => {
        const reserved = await tx.paymentIntent.updateMany({
          where: { id: intent.id, merchantId: req.merchantId!, status: 'PROCESSING' },
          data: { status: 'SUCCEEDED' },
        });
        if (reserved.count !== 1) {
          throw new ValidationError('Payment intent is already captured');
        }

        const captureTxn = await tx.transaction.create({
          data: {
            paymentIntentId: intent.id,
            merchantId: intent.merchantId,
            type: 'CAPTURE',
            amount: intent.amount,
            status: 'SUCCEEDED',
            gateway: 'RAZORPAY',
          },
        });

        await postCapture(tx, intent.merchantId, captureTxn.id, intent.amount, feeAmount, intent.currency);
      });

      res.json({
        paymentIntent: { id: intent.id, status: 'SUCCEEDED', amount: intent.amount, currency: intent.currency },
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /v1/merchants/payment-intents/:id/cancel — cancel an unfinished intent
// (anything not yet SUCCEEDED/CANCELLED/FAILED/PROCESSING). Dashboard JWT.
merchantRouter.post(
  '/payment-intents/:id/cancel',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const intent = await prisma.paymentIntent.findFirst({
        where: { id: req.params.id, merchantId: req.merchantId! },
      });

      if (!intent) throw new NotFoundError('Payment intent');
      if (['SUCCEEDED', 'CANCELLED', 'FAILED'].includes(intent.status)) {
        throw new ValidationError(`Cannot cancel intent in status: ${intent.status}`);
      }

      await prisma.$transaction(async (tx) => {
        const reserved = await tx.paymentIntent.updateMany({
          where: {
            id: intent.id,
            merchantId: req.merchantId!,
            status: { notIn: ['SUCCEEDED', 'CANCELLED', 'FAILED', 'PROCESSING'] },
          },
          data: { status: 'CANCELLED' },
        });
        if (reserved.count !== 1) {
          throw new ValidationError('Payment intent cannot be cancelled');
        }

        await tx.transaction.create({
          data: {
            paymentIntentId: intent.id,
            merchantId: intent.merchantId,
            type: 'VOID',
            amount: intent.amount,
            status: 'SUCCEEDED',
            gateway: 'RAZORPAY',
          },
        });
      });

      res.json({
        paymentIntent: { id: intent.id, status: 'CANCELLED', amount: intent.amount, currency: intent.currency },
      });
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

// GET /v1/merchants/customers — full customer roster with purchase aggregates
//
// Returns every customer the merchant has interacted with, joined with
//   - lifetime spend / payment counts (across THIS merchant's intents only)
//   - count of saved payment methods
//   - wallet balance from Redis (defaults to 0 if Redis is empty)
//   - createdAt / lastPaymentAt for "newest customer" / "active recently" sorts
//
// "Interacted with" means either:
//   1. Customer's home merchant is this one (customer.merchantId === me)
//   2. Customer has ever paid this merchant via a PaymentIntent
//
// The second branch matters because the public-portal customer registration
// (POST /customers/register/public) attaches the new Customer record to
// `prisma.merchant.findFirst()` — i.e. an arbitrary merchant — but the
// resulting payments still target the correct merchant. So a customer who
// registered on the platform and paid you should still appear in your roster.
//
// Powers the merchant dashboard's "All Customers" panel.
merchantRouter.get(
  '/customers',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const merchantId = req.merchantId!;

      const customers = await prisma.customer.findMany({
        where: {
          OR: [
            { merchantId },
            { paymentIntents: { some: { merchantId } } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { paymentMethods: true } },
          // Only this merchant's intents count toward aggregates — a customer
          // who paid a different merchant shouldn't inflate this merchant's
          // "totalSpent" / "totalPayments" numbers.
          paymentIntents: {
            where: { merchantId },
            select: {
              id: true,
              amount: true,
              currency: true,
              status: true,
              createdAt: true,
            },
          },
        },
      });

      const result = await Promise.all(
        customers.map(async (c) => {
          const successfulIntents = c.paymentIntents.filter((i) => i.status === 'SUCCEEDED');
          const totalSpent = successfulIntents.reduce((sum, i) => sum + i.amount, 0);
          const lastPaymentAt =
            c.paymentIntents.length > 0
              ? c.paymentIntents
                  .map((i) => i.createdAt.getTime())
                  .reduce((a, b) => Math.max(a, b))
              : null;

          const balanceStr = await redis.get(`wallet:balance:${c.id}`);
          const walletBalance = balanceStr ? parseInt(balanceStr, 10) : 0;

          return {
            id: c.id,
            name: c.name,
            email: c.email,
            phone: c.phone ?? null,
            createdAt: c.createdAt,
            walletBalance,
            totalSpent,
            totalPayments: c.paymentIntents.length,
            successfulPayments: successfulIntents.length,
            paymentMethodCount: c._count.paymentMethods,
            lastPaymentAt: lastPaymentAt ? new Date(lastPaymentAt) : null,
            currency: c.paymentIntents[0]?.currency ?? 'INR',
            // Flag whether this customer is the merchant's own (vs. a
            // platform-registered shopper who only paid us). Useful for UI
            // tagging.
            isOwnCustomer: c.merchantId === merchantId,
          };
        })
      );

      res.json({ customers: result });
    } catch (err) {
      next(err);
    }
  }
);

// GET /v1/merchants/wallets — get all customers with their wallet balances
//
// Mirrors the inclusion logic of GET /merchants/customers: any customer who
// has interacted with this merchant (owned OR paid us) is returned.
merchantRouter.get(
  '/wallets',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const merchantId = req.merchantId!;
      const customers = await prisma.customer.findMany({
        where: {
          OR: [
            { merchantId },
            { paymentIntents: { some: { merchantId } } },
          ],
        },
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

      // Verify the merchant has any relationship with this customer (owned
      // OR has accepted at least one payment from them). Same trust model as
      // GET /merchants/customers — guests-with-history must show up too.
      const customer = await prisma.customer.findFirst({
        where: {
          id: customerId,
          OR: [
            { merchantId: req.merchantId! },
            { paymentIntents: { some: { merchantId: req.merchantId! } } },
          ],
        },
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

// POST /v1/merchants/customers — create a new customer from the merchant
// dashboard. JWT-scoped wrapper around the API-key /customers endpoint so
// merchants don't have to mint a key with customers:write just to use the UI.
//
// `externalId` is auto-generated when not provided so the dashboard form can
// stay a simple "name / email / phone" 3-field UX. Power users (CSV imports,
// CRMs) can still pass their own.
merchantRouter.post(
  '/customers',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = z
        .object({
          externalId: z.string().min(1).max(200).optional(),
          email: z.string().email().optional(),
          phone: z
            .string()
            .regex(/^\+?[1-9]\d{1,14}$/)
            .optional(),
          name: z.string().max(200).optional(),
        })
        .parse(req.body);

      const externalId = data.externalId ?? `cust_${crypto.randomBytes(8).toString('hex')}`;

      const existing = await prisma.customer.findUnique({
        where: {
          merchantId_externalId: { merchantId: req.merchantId!, externalId },
        },
      });
      if (existing) {
        throw new ConflictError(`Customer with externalId '${externalId}' already exists`);
      }

      const customer = await prisma.customer.create({
        data: {
          merchantId: req.merchantId!,
          externalId,
          email: data.email,
          phone: data.phone,
          name: data.name,
        },
      });

      res.status(201).json({ customer });
    } catch (err) {
      next(err);
    }
  }
);

// GET /v1/merchants/customers/:id — full customer drill-down (profile +
// payment methods + recent intents). Same trust model as the listing route:
// a merchant can read any customer they own OR who has paid them.
merchantRouter.get(
  '/customers/:id',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const merchantId = req.merchantId!;
      const customer = await prisma.customer.findFirst({
        where: {
          id: req.params.id,
          OR: [
            { merchantId },
            { paymentIntents: { some: { merchantId } } },
          ],
        },
        include: {
          paymentMethods: {
            select: {
              id: true,
              type: true,
              brand: true,
              last4: true,
              expMonth: true,
              expYear: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
          },
          paymentIntents: {
            where: { merchantId },
            select: {
              id: true,
              amount: true,
              currency: true,
              status: true,
              captureMethod: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
            take: 25,
          },
        },
      });
      if (!customer) throw new NotFoundError('Customer');

      const balanceStr = await redis.get(`wallet:balance:${customer.id}`);
      const walletBalance = balanceStr ? parseInt(balanceStr, 10) : 0;

      const isOwnCustomer = customer.merchantId === merchantId;

      res.json({
        customer: {
          id: customer.id,
          externalId: customer.externalId,
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
          createdAt: customer.createdAt,
          isOwnCustomer,
          walletBalance,
          paymentMethods: customer.paymentMethods,
          paymentIntents: customer.paymentIntents,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /v1/merchants/customers-search?q=&include_own=&limit= — search the
// GLOBAL customer table (all merchants).
//
// Two modes:
//   - default (`include_own=false`): excludes customers owned by this
//     merchant. Used by the "Import existing customer" modal.
//   - `include_own=true`: returns ALL customers (this merchant's own,
//     guests who paid them, and customers from other merchants). Used by
//     the "Create Payment Link" customer dropdown so any customer in the
//     database is selectable.
//
// `limit` defaults to 25, capped at 500. Larger values are useful when the
// frontend wants to render the entire roster in a <select>; smaller values
// keep the import search lightweight.
//
// Each row carries an `isOwnCustomer` boolean so the UI can group results.
// `alreadyImported` flags candidates whose email is already in this
// merchant's roster (to warn before a duplicate import).
merchantRouter.get(
  '/customers-search',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { q, include_own, limit } = z
        .object({
          q: z.string().min(1).max(200).optional(),
          include_own: z
            .union([z.literal('true'), z.literal('false')])
            .optional()
            .transform((v) => v === 'true'),
          limit: z.coerce.number().int().min(1).max(500).default(25),
        })
        .parse(req.query);

      const merchantId = req.merchantId!;

      const where: any = {};
      if (!include_own) {
        // Exclude customers already owned by this merchant — caller is the
        // import flow, which doesn't want to copy a customer we already own.
        where.merchantId = { not: merchantId };
      }

      if (q) {
        where.OR = [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q } },
          { externalId: { contains: q, mode: 'insensitive' } },
        ];
      }

      const candidates = await prisma.customer.findMany({
        where,
        select: {
          id: true,
          merchantId: true,
          name: true,
          email: true,
          phone: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      // Flag GUEST candidates whose email already exists under this merchant
      // so the UI can warn before importing a duplicate-by-email record.
      // Own customers are skipped — they're already "in your roster" by
      // virtue of merchantId === me, no import needed.
      const guestEmails = candidates
        .filter((c) => c.merchantId !== merchantId && c.email)
        .map((c) => c.email!) as string[];
      const existingMine = guestEmails.length
        ? await prisma.customer.findMany({
            where: { merchantId, email: { in: guestEmails } },
            select: { email: true },
          })
        : [];
      const existingEmails = new Set(existingMine.map((c) => c.email));

      const data = candidates.map((c) => {
        const isOwn = c.merchantId === merchantId;
        return {
          id: c.id,
          name: c.name,
          email: c.email,
          phone: c.phone,
          createdAt: c.createdAt,
          isOwnCustomer: isOwn,
          alreadyImported: isOwn ? false : c.email ? existingEmails.has(c.email) : false,
        };
      });

      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// POST /v1/merchants/customers/import — copy a customer from the global pool
// into this merchant's roster. Non-destructive: the source customer record
// is left untouched, and a new owned customer is created with copied profile
// fields and a fresh externalId. Future invoices the merchant creates can
// reference the new owned customer; historical "guest" payments still link
// back to the source record.
merchantRouter.post(
  '/customers/import',
  requireJwt,
  requireTotpVerified,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sourceCustomerId } = z
        .object({ sourceCustomerId: z.string().uuid() })
        .parse(req.body);

      const merchantId = req.merchantId!;

      const source = await prisma.customer.findUnique({
        where: { id: sourceCustomerId },
        select: { id: true, merchantId: true, name: true, email: true, phone: true },
      });
      if (!source) throw new NotFoundError('Customer');
      if (source.merchantId === merchantId) {
        throw new ValidationError('Customer is already owned by this merchant');
      }

      // Reject if the merchant already has a customer with this email — it
      // would create a confusing duplicate. Caller should use the existing
      // record instead.
      if (source.email) {
        const dupe = await prisma.customer.findFirst({
          where: { merchantId, email: source.email },
          select: { id: true, name: true },
        });
        if (dupe) {
          throw new ConflictError(
            `You already have a customer with email '${source.email}' (${dupe.name ?? dupe.id})`
          );
        }
      }

      const externalId = `cust_imported_${crypto.randomBytes(6).toString('hex')}`;

      const created = await prisma.customer.create({
        data: {
          merchantId,
          externalId,
          name: source.name,
          email: source.email,
          phone: source.phone,
        },
      });

      res.status(201).json({ customer: created, sourceCustomerId: source.id });
    } catch (err) {
      next(err);
    }
  }
);

