import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireApiKey, requireScope } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { ConflictError, NotFoundError, ValidationError, AppError } from '../utils/errors';
import crypto from 'crypto';
import { redis } from '../redis';
import { config } from '../config';
import { calculateFee } from '../services/fees';
import { postCapture, postLedgerEntries } from '../services/ledger';

export const customerRouter = Router();

// POST /v1/customers/register/public — register a new customer publicly (no JWT)
customerRouter.post('/register/public', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, name, phone } = z.object({
      email: z.string().email(),
      name: z.string().min(2).max(100),
      phone: z.string().regex(/^\+?[1-9]\d{1,14}$/).optional(),
    }).parse(req.body);

    // Get first merchant as tenant context fallback
    const merchant = await prisma.merchant.findFirst();
    if (!merchant) {
      throw new Error('No default merchant found to associate customer with. Run database seed first.');
    }

    const existing = await prisma.customer.findFirst({
      where: { email },
    });

    if (existing) {
      res.status(200).json({ customer: existing });
      return;
    }

    const customer = await prisma.customer.create({
      data: {
        merchantId: merchant.id,
        externalId: `ext_${crypto.randomBytes(4).toString('hex')}`,
        email,
        name,
        phone,
      },
    });

    res.status(201).json({ customer });
  } catch (err) {
    next(err);
  }
});

// POST /v1/customers/login/public — login customer publicly by email (no JWT)
customerRouter.post('/login/public', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = z.object({
      email: z.string().email(),
    }).parse(req.body);

    const customer = await prisma.customer.findFirst({
      where: { email },
    });

    if (!customer) {
      throw new NotFoundError('Customer account not found with this email');
    }

    res.json({ customer });
  } catch (err) {
    next(err);
  }
});

// GET /v1/customers/:id/payments/public — list customer payments publicly (no JWT)
customerRouter.get('/:id/payments/public', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const payments = await prisma.paymentIntent.findMany({
      where: { customerId: req.params.id },
      orderBy: { createdAt: 'desc' },
      include: {
        merchant: {
          select: {
            name: true,
          },
        },
      },
    });
    res.json({ payments });
  } catch (err) {
    next(err);
  }
});

// GET /v1/customers/:id/methods/public — list customer payment methods publicly (no JWT)
customerRouter.get('/:id/methods/public', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const methods = await prisma.paymentMethod.findMany({
      where: { customerId: req.params.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ methods });
  } catch (err) {
    next(err);
  }
});

// GET /v1/customers/:id/wallet/public — fetch public wallet details (balance + transactions)
customerRouter.get('/:id/wallet/public', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = req.params.id;
    const balanceStr = await redis.get(`wallet:balance:${customerId}`);
    const balance = balanceStr ? parseInt(balanceStr, 10) : 0;

    const txnsRaw = await redis.lrange(`wallet:transactions:${customerId}`, 0, -1);
    const transactions = txnsRaw.map((t) => JSON.parse(t));

    res.json({ balance, transactions });
  } catch (err) {
    next(err);
  }
});

// POST /v1/customers/:id/wallet/order/public — create Razorpay Order for wallet top-up
customerRouter.post('/:id/wallet/order/public', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = req.params.id;
    const { amount } = z.object({
      amount: z.number().int().min(100), // min ₹1 = 100 paise
    }).parse(req.body);

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!customer) throw new NotFoundError('Customer');

    // Call Razorpay Order API
    const auth = Buffer.from(`${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`).toString('base64');
    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount,
        currency: 'INR',
        receipt: `rcpt_wallet_${crypto.randomBytes(6).toString('hex')}`,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Razorpay Wallet Order creation failed:', errorText);
      throw new AppError('Failed to create wallet order with gateway', 502, 'gateway_unavailable');
    }

    const orderData = await response.json() as any;
    res.json({
      orderId: orderData.id,
      amount: orderData.amount,
      currency: orderData.currency,
      razorpayKeyId: config.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/customers/:id/wallet/topup/public — confirm Razorpay payment and top up wallet
customerRouter.post('/:id/wallet/topup/public', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = req.params.id;
    const { amount, razorpay_payment_id, razorpay_order_id, razorpay_signature } = z.object({
      amount: z.number().int().positive(),
      razorpay_payment_id: z.string(),
      razorpay_order_id: z.string(),
      razorpay_signature: z.string(),
    }).parse(req.body);

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      include: { merchant: { include: { feePlan: true } } },
    });
    if (!customer) throw new NotFoundError('Customer');
    const merchantId = customer.merchantId;

    // Verify signature
    const hmac = crypto.createHmac('sha256', config.RAZORPAY_KEY_SECRET);
    hmac.update(razorpay_order_id + '|' + razorpay_payment_id);
    const generatedSignature = hmac.digest('hex');
    if (generatedSignature !== razorpay_signature) {
      throw new ValidationError('Invalid signature verification payload');
    }

    // Increment balance
    const nextBalance = await redis.incrby(`wallet:balance:${customerId}`, amount);

    // Push transaction log
    const newTxn = {
      id: `txn_${crypto.randomBytes(8).toString('hex')}`,
      type: 'TOPUP',
      amount,
      status: 'SUCCEEDED',
      date: new Date(),
      ref: razorpay_payment_id,
    };
    await redis.lpush(`wallet:transactions:${customerId}`, JSON.stringify(newTxn));

    // Create Postgres records: PaymentIntent & Transaction
    const clientSecret = crypto.randomBytes(32).toString('hex');
    const clientSecretHash = crypto.createHash('sha256').update(clientSecret).digest('hex');
    const intent = await prisma.paymentIntent.create({
      data: {
        merchantId,
        customerId,
        amount,
        currency: 'INR',
        status: 'SUCCEEDED',
        clientSecret: clientSecretHash,
        idempotencyKey: `topup_${razorpay_payment_id}`,
        metadata: { type: 'wallet_topup', method: 'razorpay' },
      },
    });

    const captureTxn = await prisma.transaction.create({
      data: {
        paymentIntentId: intent.id,
        merchantId,
        type: 'CAPTURE',
        amount,
        status: 'SUCCEEDED',
        gateway: 'RAZORPAY',
        gatewayTxnId: razorpay_payment_id,
        processorResponse: { method: 'razorpay', outcome: 'SUCCESS' },
      },
    });

    const feeAmount = calculateFee(amount, customer.merchant.feePlan, false);
    await prisma.$transaction(async (tx) => {
      await postCapture(
        tx,
        merchantId,
        captureTxn.id,
        amount,
        feeAmount,
        'INR'
      );
    });

    res.json({ balance: nextBalance, transaction: newTxn });
  } catch (err) {
    next(err);
  }
});

// POST /v1/customers/:id/wallet/withdraw/public — withdraw from customer wallet
customerRouter.post('/:id/wallet/withdraw/public', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = req.params.id;
    const { amount } = z.object({
      amount: z.number().int().positive(),
    }).parse(req.body);

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!customer) throw new NotFoundError('Customer');

    const balanceStr = await redis.get(`wallet:balance:${customerId}`);
    const available = balanceStr ? parseInt(balanceStr, 10) : 0;

    if (amount > available) {
      throw new ValidationError(`Insufficient wallet balance (Available: ₹${available / 100}, Requested: ₹${amount / 100})`);
    }

    const nextBalance = await redis.decrby(`wallet:balance:${customerId}`, amount);

    const newTxn = {
      id: `txn_${crypto.randomBytes(8).toString('hex')}`,
      type: 'WITHDRAWAL',
      amount,
      status: 'SUCCEEDED',
      date: new Date(),
      ref: `wth_${crypto.randomBytes(6).toString('hex')}`,
    };
    await redis.lpush(`wallet:transactions:${customerId}`, JSON.stringify(newTxn));

    // Post to ledger: debits merchant AVAILABLE, credits PROCESSOR
    await prisma.$transaction(async (tx) => {
      await postLedgerEntries(tx, customer.merchantId, [
        {
          account: 'AVAILABLE',
          delta: -amount,
          refType: 'WITHDRAWAL',
          refId: newTxn.id,
          currency: 'INR',
        },
        {
          account: 'PROCESSOR',
          delta: +amount,
          refType: 'WITHDRAWAL',
          refId: newTxn.id,
          currency: 'INR',
        },
      ]);
    });

    res.json({ balance: nextBalance, transaction: newTxn });
  } catch (err) {
    next(err);
  }
});

// POST /v1/customers/:id/wallet/topup/dummy — simulated wallet top-up with interactive outcomes
customerRouter.post('/:id/wallet/topup/dummy', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = req.params.id;
    const { amount, outcome, payment_method } = z.object({
      amount: z.number().int().positive(),
      outcome: z.enum(['SUCCESS', 'FAILURE_DECLINED', 'FAILURE_REVERTED']).default('SUCCESS'),
      payment_method: z.string().default('card'),
    }).parse(req.body);

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      include: { merchant: { include: { feePlan: true } } },
    });
    if (!customer) throw new NotFoundError('Customer');
    const merchantId = customer.merchantId;

    let nextBalance = 0;
    const balanceStr = await redis.get(`wallet:balance:${customerId}`);
    const currentBalance = balanceStr ? parseInt(balanceStr, 10) : 0;

    const dummyRef = `dmy_${payment_method}_${crypto.randomBytes(6).toString('hex')}`;

    if (outcome === 'SUCCESS') {
      // 1. SUCCESS: Increment balance and log succeeded topup
      nextBalance = await redis.incrby(`wallet:balance:${customerId}`, amount);
      const newTxn = {
        id: `txn_${crypto.randomBytes(8).toString('hex')}`,
        type: 'TOPUP',
        amount,
        status: 'SUCCEEDED',
        date: new Date(),
        ref: dummyRef,
      };
      await redis.lpush(`wallet:transactions:${customerId}`, JSON.stringify(newTxn));

      // Postgres Integration
      const clientSecret = crypto.randomBytes(32).toString('hex');
      const clientSecretHash = crypto.createHash('sha256').update(clientSecret).digest('hex');
      const intent = await prisma.paymentIntent.create({
        data: {
          merchantId,
          customerId,
          amount,
          currency: 'INR',
          status: 'SUCCEEDED',
          clientSecret: clientSecretHash,
          idempotencyKey: `topup_${dummyRef}`,
          metadata: { type: 'wallet_topup', method: payment_method },
        },
      });

      const captureTxn = await prisma.transaction.create({
        data: {
          paymentIntentId: intent.id,
          merchantId,
          type: 'CAPTURE',
          amount,
          status: 'SUCCEEDED',
          gateway: 'DUMMY',
          gatewayTxnId: dummyRef,
          processorResponse: { method: payment_method, outcome },
        },
      });

      const feeAmount = calculateFee(amount, customer.merchant.feePlan, false);
      await prisma.$transaction(async (tx) => {
        await postCapture(
          tx,
          merchantId,
          captureTxn.id,
          amount,
          feeAmount,
          'INR'
        );
      });

      res.json({ balance: nextBalance, transaction: newTxn, outcome });
    } else if (outcome === 'FAILURE_DECLINED') {
      // 2. FAILURE_DECLINED: Log failed topup, balance unchanged
      nextBalance = currentBalance;
      const newTxn = {
        id: `txn_${crypto.randomBytes(8).toString('hex')}`,
        type: 'TOPUP',
        amount,
        status: 'FAILED',
        date: new Date(),
        ref: dummyRef,
      };
      await redis.lpush(`wallet:transactions:${customerId}`, JSON.stringify(newTxn));

      // Postgres Integration
      const clientSecret = crypto.randomBytes(32).toString('hex');
      const clientSecretHash = crypto.createHash('sha256').update(clientSecret).digest('hex');
      const intent = await prisma.paymentIntent.create({
        data: {
          merchantId,
          customerId,
          amount,
          currency: 'INR',
          status: 'FAILED',
          clientSecret: clientSecretHash,
          idempotencyKey: `topup_${dummyRef}`,
          metadata: { type: 'wallet_topup', method: payment_method },
        },
      });

      await prisma.transaction.create({
        data: {
          paymentIntentId: intent.id,
          merchantId,
          type: 'CAPTURE',
          amount,
          status: 'FAILED',
          gateway: 'DUMMY',
          gatewayTxnId: dummyRef,
          processorResponse: { method: payment_method, outcome, declineReason: 'Card Declined' },
        },
      });

      res.json({ balance: nextBalance, transaction: newTxn, outcome });
    } else if (outcome === 'FAILURE_REVERTED') {
      // 3. FAILURE_REVERTED: Money cut (increment) then reverted (decrement)
      // Log succeeded topup in Redis
      const topupTxnId = `txn_${crypto.randomBytes(8).toString('hex')}`;
      const topupTxn = {
        id: topupTxnId,
        type: 'TOPUP',
        amount,
        status: 'SUCCEEDED',
        date: new Date(),
        ref: dummyRef,
      };

      // Log reversal transaction in Redis
      const revertTxnId = `txn_${crypto.randomBytes(8).toString('hex')}`;
      const revertTxn = {
        id: revertTxnId,
        type: 'REVERSAL',
        amount,
        status: 'SUCCEEDED',
        date: new Date(),
        ref: `rev_${topupTxnId.slice(-6)}`,
      };

      // Push both to Redis transaction log
      await redis.lpush(`wallet:transactions:${customerId}`, JSON.stringify(topupTxn));
      await redis.lpush(`wallet:transactions:${customerId}`, JSON.stringify(revertTxn));

      // Balance remains unchanged net-wise
      nextBalance = currentBalance;

      // Postgres Integration
      const clientSecret = crypto.randomBytes(32).toString('hex');
      const clientSecretHash = crypto.createHash('sha256').update(clientSecret).digest('hex');
      const intent = await prisma.paymentIntent.create({
        data: {
          merchantId,
          customerId,
          amount,
          currency: 'INR',
          status: 'FAILED',
          clientSecret: clientSecretHash,
          idempotencyKey: `topup_${dummyRef}`,
          metadata: { type: 'wallet_topup', method: payment_method },
        },
      });

      const captureTxn = await prisma.transaction.create({
        data: {
          paymentIntentId: intent.id,
          merchantId,
          type: 'CAPTURE',
          amount,
          status: 'SUCCEEDED',
          gateway: 'DUMMY',
          gatewayTxnId: dummyRef,
          processorResponse: { method: payment_method, outcome, note: 'Funds captured' },
        },
      });

      const dbRevertTxnId = `dmy_rev_${crypto.randomBytes(8).toString('hex')}`;
      await prisma.transaction.create({
        data: {
          paymentIntentId: intent.id,
          merchantId,
          type: 'VOID',
          amount,
          status: 'SUCCEEDED',
          gateway: 'DUMMY',
          gatewayTxnId: dbRevertTxnId,
          processorResponse: { method: payment_method, outcome, note: 'Automatically reverted/refunded due to system failure' },
        },
      });

      const feeAmount = calculateFee(amount, customer.merchant.feePlan, false);
      const netAmount = amount - feeAmount;
      await prisma.$transaction(async (tx) => {
        await postCapture(
          tx,
          merchantId,
          captureTxn.id,
          amount,
          feeAmount,
          'INR'
        );
        await postLedgerEntries(tx, merchantId, [
          {
            account: 'PROCESSOR',
            delta: +amount,
            refType: 'VOID',
            refId: dbRevertTxnId,
            currency: 'INR',
          },
          {
            account: 'PENDING',
            delta: -netAmount,
            refType: 'VOID',
            refId: dbRevertTxnId,
            currency: 'INR',
          },
          {
            account: 'FEES',
            delta: -feeAmount,
            refType: 'VOID',
            refId: dbRevertTxnId,
            currency: 'INR',
          },
        ]);
      });

      res.json({ balance: nextBalance, transaction: topupTxn, outcome });
    }
  } catch (err) {
    next(err);
  }
});


// Authenticated routes require API key
customerRouter.use(requireApiKey, rateLimit());

const createCustomerSchema = z.object({
  externalId: z.string().min(1).max(200),
  email: z.string().email().optional(),
  phone: z.string().regex(/^\+?[1-9]\d{1,14}$/).optional(),
  name: z.string().max(200).optional(),
});

// POST /v1/customers
customerRouter.post('/', requireScope('customers:write'), async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = createCustomerSchema.parse(req.body);

    const existing = await prisma.customer.findUnique({
      where: {
        merchantId_externalId: {
          merchantId: req.merchantId!,
          externalId: data.externalId,
        },
      },
    });

    if (existing) {
      throw new ConflictError(
        `Customer with externalId '${data.externalId}' already exists`
      );
    }

    const customer = await prisma.customer.create({
      data: {
        merchantId: req.merchantId!,
        externalId: data.externalId,
        email: data.email,
        phone: data.phone,
        name: data.name,
      },
    });

    res.status(201).json({ customer });
  } catch (err) {
    next(err);
  }
});

// GET /v1/customers/:id
customerRouter.get('/:id', requireScope('customers:read'), async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, merchantId: req.merchantId },
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
        },
      },
    });

    if (!customer) throw new NotFoundError('Customer');

    res.json({ customer });
  } catch (err) {
    next(err);
  }
});

// GET /v1/customers — list with cursor pagination
customerRouter.get('/', requireScope('customers:read'), async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const parsedLimit = Number(req.query.limit ?? 20);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      throw new ValidationError('limit must be a positive integer', 'limit');
    }
    const limit = Math.min(parsedLimit, 100);
    const cursor = req.query.cursor as string | undefined;

    const customers = await prisma.customer.findMany({
      where: { merchantId: req.merchantId },
      take: limit + 1,
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1,
      }),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        externalId: true,
        email: true,
        name: true,
        createdAt: true,
      },
    });

    const hasMore = customers.length > limit;
    const data = hasMore ? customers.slice(0, -1) : customers;

    res.json({
      data,
      has_more: hasMore,
      next_cursor: hasMore ? data[data.length - 1].id : null,
    });
  } catch (err) {
    next(err);
  }
});
