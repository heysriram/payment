import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireApiKey, requireScope } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { postCapture, postRefund, postLedgerEntries } from '../services/ledger';
import { calculateFee } from '../services/fees';
import {
  NotFoundError,
  ValidationError,
  AppError,
} from '../utils/errors';
import crypto from 'crypto';
import { config } from '../config';

export const paymentIntentRouter = Router();

// GET /v1/payment_intents/:id/public — fetch public details for checkout
paymentIntentRouter.get('/:id/public', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const intent = await prisma.paymentIntent.findUnique({
      where: { id: req.params.id },
      include: {
        merchant: {
          select: {
            name: true,
          },
        },
      },
    });

    if (!intent) throw new NotFoundError('Payment intent');

    // Verify client secret if passed as a query param
    const clientSecretQuery = req.query.client_secret as string;
    if (!clientSecretQuery) {
      throw new ValidationError('client_secret is required');
    }

    const clientSecretHash = crypto.createHash('sha256').update(clientSecretQuery).digest('hex');
    if (intent.clientSecret !== clientSecretHash) {
      throw new ValidationError('Invalid client secret');
    }

    res.json({
      paymentIntent: {
        id: intent.id,
        amount: intent.amount,
        currency: intent.currency,
        status: intent.status,
        merchantName: intent.merchant.name,
        metadata: intent.metadata,
        razorpayOrderId: (intent.metadata as any)?.razorpay_order_id || null,
        razorpayKeyId: config.RAZORPAY_KEY_ID,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/payment_intents/:id/confirm/public — verify and capture payment publicly
paymentIntentRouter.post('/:id/confirm/public', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { client_secret, razorpay_payment_id, razorpay_order_id, razorpay_signature } = z.object({
      client_secret: z.string(),
      razorpay_payment_id: z.string(),
      razorpay_order_id: z.string(),
      razorpay_signature: z.string(),
    }).parse(req.body);

    const intent = await prisma.paymentIntent.findUnique({
      where: { id: req.params.id },
      include: {
        merchant: { include: { feePlan: true } },
      },
    });

    if (!intent) throw new NotFoundError('Payment intent');

    // Verify client secret
    const clientSecretHash = crypto.createHash('sha256').update(client_secret).digest('hex');
    if (intent.clientSecret !== clientSecretHash) {
      throw new ValidationError('Invalid client secret');
    }

    // Verify Razorpay HMAC Signature
    const hmac = crypto.createHmac('sha256', config.RAZORPAY_KEY_SECRET);
    hmac.update(razorpay_order_id + '|' + razorpay_payment_id);
    const generatedSignature = hmac.digest('hex');
    if (generatedSignature !== razorpay_signature) {
      throw new ValidationError('Invalid Razorpay signature');
    }

    // Fetch details from Razorpay to log method/type/brand/last4
    let paymentDetails: any;
    try {
      const auth = Buffer.from(`${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`).toString('base64');
      const rzpResponse = await fetch(`https://api.razorpay.com/v1/payments/${razorpay_payment_id}`, {
        headers: {
          'Authorization': `Basic ${auth}`,
        },
      });
      if (rzpResponse.ok) {
        paymentDetails = await rzpResponse.json();
      } else {
        paymentDetails = { method: 'card', card: { network: 'VISA', last4: '1111' }, international: false };
      }
    } catch (err) {
      paymentDetails = { method: 'card', card: { network: 'VISA', last4: '1111' }, international: false };
    }

    let paymentMethodId = intent.paymentMethodId;
    if (intent.customerId && !paymentMethodId) {
      const typeMap: Record<string, string> = {
        card: 'CARD',
        upi: 'UPI',
        netbanking: 'NETBANKING',
        wallet: 'WALLET',
        bank_account: 'BANK_ACCOUNT',
      };
      const pmType = typeMap[paymentDetails.method] || 'CARD';

      const existingPm = await prisma.paymentMethod.findFirst({
        where: { customerId: intent.customerId, tokenId: razorpay_payment_id },
      });

      if (existingPm) {
        paymentMethodId = existingPm.id;
      } else {
        const newPm = await prisma.paymentMethod.create({
          data: {
            customerId: intent.customerId,
            type: pmType as any,
            tokenId: razorpay_payment_id,
            brand: paymentDetails.card?.network || paymentDetails.vpa || 'Unknown',
            last4: paymentDetails.card?.last4 || null,
            expMonth: paymentDetails.card?.expiry_month || null,
            expYear: paymentDetails.card?.expiry_year || null,
            isInternational: paymentDetails.international || false,
            fingerprint: paymentDetails.card?.emi || null,
          },
        });
        paymentMethodId = newPm.id;
      }
    }

    const feeAmount = calculateFee(
      intent.amount,
      intent.merchant.feePlan,
      paymentDetails.international || false
    );

    await prisma.$transaction(async (tx) => {
      const checkIntent = await tx.paymentIntent.findUnique({
        where: { id: intent.id },
      });

      if (checkIntent?.status === 'SUCCEEDED') return;

      await tx.paymentIntent.update({
        where: { id: intent.id },
        data: {
          status: 'SUCCEEDED',
          paymentMethodId: paymentMethodId || undefined,
        },
      });

      const captureTxn = await tx.transaction.create({
        data: {
          paymentIntentId: intent.id,
          merchantId: intent.merchantId,
          type: 'CAPTURE',
          amount: intent.amount,
          status: 'SUCCEEDED',
          gateway: 'RAZORPAY',
          gatewayTxnId: razorpay_payment_id,
          processorResponse: paymentDetails,
        },
      });

      await postCapture(
        tx,
        intent.merchantId,
        captureTxn.id,
        intent.amount,
        feeAmount,
        intent.currency
      );
    });

    const updatedIntent = await prisma.paymentIntent.findUnique({
      where: { id: intent.id },
    });

    res.json({
      paymentIntent: {
        id: updatedIntent?.id,
        status: updatedIntent?.status,
        amount: updatedIntent?.amount,
        currency: updatedIntent?.currency,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/payment_intents/:id/confirm/dummy — simulated invoice capture offline
paymentIntentRouter.post('/:id/confirm/dummy', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { client_secret, outcome, payment_method } = z.object({
      client_secret: z.string(),
      outcome: z.enum(['SUCCESS', 'FAILURE_DECLINED', 'FAILURE_REVERTED']).default('SUCCESS'),
      payment_method: z.string().default('card'),
    }).parse(req.body);

    const intent = await prisma.paymentIntent.findUnique({
      where: { id: req.params.id },
      include: {
        merchant: { include: { feePlan: true } },
      },
    });

    if (!intent) throw new NotFoundError('Payment intent');

    // Verify client secret
    const clientSecretHash = crypto.createHash('sha256').update(client_secret).digest('hex');
    if (intent.clientSecret !== clientSecretHash) {
      throw new ValidationError('Invalid client secret');
    }

    const typeUpper = payment_method.toUpperCase();
    const typeMap: Record<string, any> = {
      CARD: 'CARD',
      UPI: 'UPI',
      NETBANKING: 'NETBANKING',
      WALLET: 'WALLET',
    };
    const pmType = typeMap[typeUpper] || 'CARD';

    // Mock payment details based on method
    let brand = 'VISA';
    let last4 = '9999';
    if (pmType === 'UPI') {
      brand = 'UPI / GPay';
      last4 = 'test@upi';
    } else if (pmType === 'NETBANKING') {
      brand = 'HDFC Bank';
      last4 = '1234';
    } else if (pmType === 'WALLET') {
      brand = 'Paytm Wallet';
      last4 = '8888';
    }

    const dummyPaymentId = `dmy_pm_${crypto.randomBytes(8).toString('hex')}`;

    let paymentMethodId = intent.paymentMethodId;
    if (intent.customerId && !paymentMethodId) {
      const newPm = await prisma.paymentMethod.create({
        data: {
          customerId: intent.customerId,
          type: pmType,
          tokenId: dummyPaymentId,
          brand,
          last4,
          expMonth: 12,
          expYear: 2030,
          isInternational: false,
          fingerprint: `fp_${crypto.randomBytes(6).toString('hex')}`,
        },
      });
      paymentMethodId = newPm.id;
    }

    const feeAmount = calculateFee(
      intent.amount,
      intent.merchant.feePlan,
      false
    );

    await prisma.$transaction(async (tx) => {
      const checkIntent = await tx.paymentIntent.findUnique({
        where: { id: intent.id },
      });

      if (checkIntent?.status === 'SUCCEEDED' || checkIntent?.status === 'FAILED') return;

      if (outcome === 'SUCCESS') {
        // 1. Success Flow
        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: {
            status: 'SUCCEEDED',
            paymentMethodId: paymentMethodId || undefined,
          },
        });

        const captureTxn = await tx.transaction.create({
          data: {
            paymentIntentId: intent.id,
            merchantId: intent.merchantId,
            type: 'CAPTURE',
            amount: intent.amount,
            status: 'SUCCEEDED',
            gateway: 'DUMMY',
            gatewayTxnId: dummyPaymentId,
            processorResponse: { method: payment_method, brand, last4, outcome },
          },
        });

        await postCapture(
          tx,
          intent.merchantId,
          captureTxn.id,
          intent.amount,
          feeAmount,
          intent.currency
        );
      } else if (outcome === 'FAILURE_DECLINED') {
        // 2. Failure Declined Flow (No money cut)
        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: {
            status: 'FAILED',
            paymentMethodId: paymentMethodId || undefined,
          },
        });

        await tx.transaction.create({
          data: {
            paymentIntentId: intent.id,
            merchantId: intent.merchantId,
            type: 'CAPTURE',
            amount: intent.amount,
            status: 'FAILED',
            gateway: 'DUMMY',
            gatewayTxnId: dummyPaymentId,
            processorResponse: { method: payment_method, brand, last4, outcome, declineReason: 'Card Declined' },
          },
        });
      } else if (outcome === 'FAILURE_REVERTED') {
        // 3. Failure Reverted Flow (Money cut, but reverted)
        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: {
            status: 'FAILED',
            paymentMethodId: paymentMethodId || undefined,
          },
        });

        // Create capture transaction (Succeeded)
        const captureTxn = await tx.transaction.create({
          data: {
            paymentIntentId: intent.id,
            merchantId: intent.merchantId,
            type: 'CAPTURE',
            amount: intent.amount,
            status: 'SUCCEEDED',
            gateway: 'DUMMY',
            gatewayTxnId: dummyPaymentId,
            processorResponse: { method: payment_method, brand, last4, outcome, note: 'Funds captured' },
          },
        });

        // Post capture entries
        await postCapture(
          tx,
          intent.merchantId,
          captureTxn.id,
          intent.amount,
          feeAmount,
          intent.currency
        );

        // Create void transaction (Reversed/Succeeded)
        const revertTxnId = `dmy_rev_${crypto.randomBytes(8).toString('hex')}`;
        await tx.transaction.create({
          data: {
            paymentIntentId: intent.id,
            merchantId: intent.merchantId,
            type: 'VOID',
            amount: intent.amount,
            status: 'SUCCEEDED',
            gateway: 'DUMMY',
            gatewayTxnId: revertTxnId,
            processorResponse: { method: payment_method, brand, last4, outcome, note: 'Automatically reverted/refunded due to system failure' },
          },
        });

        // Revert capture entries (atomic ledger reversal)
        const netAmount = intent.amount - feeAmount;
        await postLedgerEntries(tx, intent.merchantId, [
          {
            account: 'PROCESSOR',
            delta: +intent.amount,
            refType: 'VOID',
            refId: revertTxnId,
            currency: intent.currency,
          },
          {
            account: 'PENDING',
            delta: -netAmount,
            refType: 'VOID',
            refId: revertTxnId,
            currency: intent.currency,
          },
          {
            account: 'FEES',
            delta: -feeAmount,
            refType: 'VOID',
            refId: revertTxnId,
            currency: intent.currency,
          },
        ]);
      }
    });

    const updatedIntent = await prisma.paymentIntent.findUnique({
      where: { id: intent.id },
    });

    res.json({
      paymentIntent: {
        id: updatedIntent?.id,
        status: updatedIntent?.status,
        amount: updatedIntent?.amount,
        currency: updatedIntent?.currency,
      },
      outcome,
    });
  } catch (err) {
    next(err);
  }
});


paymentIntentRouter.use(requireApiKey, rateLimit());

const createIntentSchema = z.object({
  amount: z.number().int().min(100),   // min ₹1 = 100 paise
  currency: z.string().length(3).default('INR'),
  customerId: z.string().uuid().optional(),
  captureMethod: z.enum(['AUTOMATIC', 'MANUAL']).default('AUTOMATIC'),
  metadata: z.record(z.any()).optional(),
});

// POST /v1/payment_intents
paymentIntentRouter.post('/', requireScope('payments:write'), async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const idempotencyKey = req.headers['idempotency-key'] as string;
    if (!idempotencyKey) {
      throw new ValidationError('Idempotency-Key header is required');
    }

    // Check idempotency — return existing if seen before
    const existing = await prisma.paymentIntent.findUnique({
      where: {
        merchantId_idempotencyKey: {
          merchantId: req.merchantId!,
          idempotencyKey,
        },
      },
    });
    if (existing) {
      res.status(200).json({
        paymentIntent: { ...existing, clientSecret: undefined },
        idempotent: true,
      });
      return;
    }

    const data = createIntentSchema.parse(req.body);

    // Validate customer belongs to merchant
    if (data.customerId) {
      const customer = await prisma.customer.findFirst({
        where: { id: data.customerId, merchantId: req.merchantId },
      });
      if (!customer) throw new NotFoundError('Customer');
    }

    // Contact Razorpay to create Order
    let razorpayOrderId: string | undefined;
    try {
      const auth = Buffer.from(`${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`).toString('base64');
      const response = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: data.amount,
          currency: data.currency.toUpperCase(),
          receipt: `rcpt_${crypto.randomBytes(8).toString('hex')}`,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Razorpay Order creation failed:', errorText);
      } else {
        const orderData = await response.json() as any;
        razorpayOrderId = orderData.id;
      }
    } catch (err) {
      console.error('Error creating Razorpay order:', err);
    }

    const clientSecret = crypto.randomBytes(32).toString('base64url');
    const clientSecretHash = crypto.createHash('sha256').update(clientSecret).digest('hex');

    const metadata = {
      ...(data.metadata || {}),
      razorpay_order_id: razorpayOrderId,
    };

    const intent = await prisma.paymentIntent.create({
      data: {
        merchantId: req.merchantId!,
        customerId: data.customerId,
        amount: data.amount,
        currency: data.currency.toUpperCase(),
        status: 'REQUIRES_PM',
        clientSecret: clientSecretHash,
        idempotencyKey,
        captureMethod: data.captureMethod,
        metadata,
      },
    });

    res.status(201).json({ paymentIntent: { ...intent, clientSecret } });
  } catch (err) {
    next(err);
  }
});

// POST /v1/payment_intents/:id/confirm
paymentIntentRouter.post('/:id/confirm', requireScope('payments:write'), async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const intent = await prisma.paymentIntent.findFirst({
      where: { id: req.params.id, merchantId: req.merchantId },
      include: {
        merchant: { include: { feePlan: true } },
      },
    });

    if (!intent) throw new NotFoundError('Payment intent');

    // Handle Razorpay Payment Signature Verification Flow
    const body = req.body;
    if (body.razorpay_payment_id && body.razorpay_order_id && body.razorpay_signature) {
      const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = z.object({
        razorpay_payment_id: z.string(),
        razorpay_order_id: z.string(),
        razorpay_signature: z.string(),
      }).parse(body);

      // Verify Razorpay HMAC Signature
      const hmac = crypto.createHmac('sha256', config.RAZORPAY_KEY_SECRET);
      hmac.update(razorpay_order_id + '|' + razorpay_payment_id);
      const generatedSignature = hmac.digest('hex');
      if (generatedSignature !== razorpay_signature) {
        throw new ValidationError('Invalid Razorpay signature');
      }

      // Fetch payment details from Razorpay to log method/type/brand/last4
      let paymentDetails: any;
      try {
        const auth = Buffer.from(`${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`).toString('base64');
        const rzpResponse = await fetch(`https://api.razorpay.com/v1/payments/${razorpay_payment_id}`, {
          headers: {
            'Authorization': `Basic ${auth}`,
          },
        });
        if (!rzpResponse.ok) {
          throw new AppError('Failed to retrieve payment details from Razorpay', 502, 'gateway_unavailable');
        }
        paymentDetails = await rzpResponse.json();
      } catch (err) {
        console.error('Error fetching Razorpay payment details:', err);
        paymentDetails = { method: 'card', card: { network: 'VISA', last4: '1111' }, international: false };
      }

      let paymentMethodId = intent.paymentMethodId;
      if (intent.customerId && !paymentMethodId) {
        const typeMap: Record<string, string> = {
          card: 'CARD',
          upi: 'UPI',
          netbanking: 'NETBANKING',
          wallet: 'WALLET',
          bank_account: 'BANK_ACCOUNT',
        };
        const pmType = typeMap[paymentDetails.method] || 'CARD';

        // Check if token already exists
        const existingPm = await prisma.paymentMethod.findFirst({
          where: {
            customerId: intent.customerId,
            tokenId: razorpay_payment_id,
          },
        });

        if (existingPm) {
          paymentMethodId = existingPm.id;
        } else {
          const newPm = await prisma.paymentMethod.create({
            data: {
              customerId: intent.customerId,
              type: pmType as any,
              tokenId: razorpay_payment_id,
              brand: paymentDetails.card?.network || paymentDetails.vpa || 'Unknown',
              last4: paymentDetails.card?.last4 || null,
              expMonth: paymentDetails.card?.expiry_month || null,
              expYear: paymentDetails.card?.expiry_year || null,
              isInternational: paymentDetails.international || false,
              fingerprint: paymentDetails.card?.emi || null,
            },
          });
          paymentMethodId = newPm.id;
        }
      }

      const feeAmount = calculateFee(
        intent.amount,
        intent.merchant.feePlan,
        paymentDetails.international || false
      );

      await prisma.$transaction(async (tx) => {
        const checkIntent = await tx.paymentIntent.findUnique({
          where: { id: intent.id },
        });

        if (checkIntent?.status === 'SUCCEEDED') return;

        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: {
            status: 'SUCCEEDED',
            paymentMethodId: paymentMethodId || undefined,
          },
        });

        const captureTxn = await tx.transaction.create({
          data: {
            paymentIntentId: intent.id,
            merchantId: intent.merchantId,
            type: 'CAPTURE',
            amount: intent.amount,
            status: 'SUCCEEDED',
            gateway: 'RAZORPAY',
            gatewayTxnId: razorpay_payment_id,
            processorResponse: paymentDetails,
          },
        });

        await postCapture(
          tx,
          intent.merchantId,
          captureTxn.id,
          intent.amount,
          feeAmount,
          intent.currency
        );
      });

      const updatedIntent = await prisma.paymentIntent.findUnique({
        where: { id: intent.id },
      });

      res.json({
        paymentIntent: { ...updatedIntent, clientSecret: undefined },
      });
      return;
    }

    // Fallback to vault tokenization flow
    if (!['REQUIRES_PM', 'REQUIRES_CONFIRMATION'].includes(intent.status)) {
      throw new ValidationError(
        `Cannot confirm intent in status: ${intent.status}`
      );
    }

    const { paymentMethodId } = z.object({
      paymentMethodId: z.string().uuid(),
    }).parse(req.body);

    const paymentMethod = await prisma.paymentMethod.findFirst({
      where: {
        id: paymentMethodId,
        customer: { merchantId: req.merchantId },
      },
    });
    if (!paymentMethod) throw new NotFoundError('Payment method');
    if (intent.customerId && paymentMethod.customerId !== intent.customerId) {
      throw new ValidationError('Payment method does not belong to the intent customer');
    }
    if (req.keyMode === 'LIVE') {
      throw new AppError('Live payment processing is not configured', 503, 'gateway_unavailable');
    }

    const reserved = await prisma.paymentIntent.updateMany({
      where: {
        id: intent.id,
        merchantId: req.merchantId,
        status: { in: ['REQUIRES_PM', 'REQUIRES_CONFIRMATION'] },
      },
      data: { status: 'PROCESSING', paymentMethodId: paymentMethod.id },
    });
    if (reserved.count !== 1) {
      throw new ValidationError('Payment intent is already being processed');
    }

    // Call Razorpay to auth the payment
    // (Razorpay integration in next step — stubbed here)
    const gatewayResult = await chargeViaGateway(
      intent,
      paymentMethod.tokenId
    );

    if (gatewayResult.requiresAction) {
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: 'REQUIRES_ACTION' },
      });
      res.json({
        paymentIntent: { ...intent, status: 'REQUIRES_ACTION', clientSecret: undefined, merchant: undefined },
        nextAction: { type: '3ds_redirect', url: gatewayResult.redirectUrl },
      });
      return;
    }

    if (!gatewayResult.success) {
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: 'FAILED' },
      });

      // Write failed transaction
      await prisma.transaction.create({
        data: {
          paymentIntentId: intent.id,
          merchantId: intent.merchantId,
          type: 'AUTH',
          amount: intent.amount,
          status: 'FAILED',
          gateway: 'RAZORPAY',
          gatewayTxnId: gatewayResult.gatewayTxnId,
          processorResponse: gatewayResult.raw as object,
        },
      });

      throw new AppError(
        gatewayResult.declineReason ?? 'Payment failed',
        402,
        'card_declined',
      );
    }

    // Auth succeeded — write AUTH transaction
    await prisma.transaction.create({
      data: {
        paymentIntentId: intent.id,
        merchantId: intent.merchantId,
        type: 'AUTH',
        amount: intent.amount,
        status: 'SUCCEEDED',
        gateway: 'RAZORPAY',
        gatewayTxnId: gatewayResult.gatewayTxnId,
        processorResponse: gatewayResult.raw as object,
      },
    });

    // Auto capture if applicable
    if (intent.captureMethod === 'AUTOMATIC') {
      const feeAmount = calculateFee(
        intent.amount,
        intent.merchant.feePlan,
        paymentMethod.isInternational
      );

      await prisma.$transaction(async (tx) => {
        const captureTxn = await tx.transaction.create({
          data: {
            paymentIntentId: intent.id,
            merchantId: intent.merchantId,
            type: 'CAPTURE',
            amount: intent.amount,
            status: 'SUCCEEDED',
            gateway: 'RAZORPAY',
            gatewayTxnId: gatewayResult.gatewayTxnId,
            processorResponse: gatewayResult.raw as object,
          },
        });

        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: { status: 'SUCCEEDED' },
        });

        await postCapture(
          tx,
          intent.merchantId,
          captureTxn.id,
          intent.amount,
          feeAmount,
          intent.currency
        );
      });

      res.json({
        paymentIntent: { ...intent, status: 'SUCCEEDED', clientSecret: undefined, merchant: undefined },
      });
      return;
    }

    // Manual capture — leave in PROCESSING
    res.json({
      paymentIntent: { ...intent, status: 'PROCESSING', clientSecret: undefined, merchant: undefined },
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/payment_intents/:id/capture — manual capture
paymentIntentRouter.post('/:id/capture', requireScope('payments:write'), async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const intent = await prisma.paymentIntent.findFirst({
      where: { id: req.params.id, merchantId: req.merchantId },
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
        where: { id: intent.id, merchantId: req.merchantId, status: 'PROCESSING' },
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
      paymentIntent: {
        ...intent,
        status: 'SUCCEEDED',
        clientSecret: undefined,
        merchant: undefined,
        paymentMethod: undefined,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/payment_intents/:id/cancel
paymentIntentRouter.post('/:id/cancel', requireScope('payments:write'), async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const intent = await prisma.paymentIntent.findFirst({
      where: { id: req.params.id, merchantId: req.merchantId },
    });

    if (!intent) throw new NotFoundError('Payment intent');
    if (['SUCCEEDED', 'CANCELLED', 'FAILED'].includes(intent.status)) {
      throw new ValidationError(`Cannot cancel intent in status: ${intent.status}`);
    }

    await prisma.$transaction(async (tx) => {
      const reserved = await tx.paymentIntent.updateMany({
        where: {
          id: intent.id,
          merchantId: req.merchantId,
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

    res.json({ paymentIntent: { ...intent, status: 'CANCELLED', clientSecret: undefined } });
  } catch (err) {
    next(err);
  }
});

// POST /v1/payment_intents/:id/refund
paymentIntentRouter.post('/:id/refund', requireScope('refunds:write'), async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { amount, reason } = z.object({
      amount: z.number().int().positive().optional(),
      reason: z.string().optional(),
    }).parse(req.body);

    const intent = await prisma.paymentIntent.findFirst({
      where: { id: req.params.id, merchantId: req.merchantId },
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

    // Call Razorpay Refund API if in live mode (mocked in test/sandbox)
    let gatewayRefundId = `rfnd_${crypto.randomBytes(8).toString('hex')}`;
    if (req.keyMode === 'LIVE') {
      throw new AppError('Live refund processing is not configured', 503, 'gateway_unavailable');
    }

    const refund = await prisma.$transaction(async (tx) => {
      const newRefund = await tx.refund.create({
        data: {
          transactionId: captureTxn.id,
          amount: refundAmount,
          reason: reason || 'Merchant requested refund',
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
});

// ── Gateway stub — replaced with real Razorpay in Step 27 ────────
async function chargeViaGateway(
  intent: { id: string; amount: number; currency: string },
  tokenId: string
): Promise<{
  success: boolean;
  requiresAction: boolean;
  redirectUrl?: string;
  gatewayTxnId?: string;
  declineReason?: string;
  raw?: unknown;
}> {
  // Stub — always succeeds in test mode
  // Real Razorpay call goes here in Step 27
  return {
    success: true,
    requiresAction: false,
    gatewayTxnId: `rzp_${crypto.randomBytes(8).toString('hex')}`,
    raw: { stub: true, tokenId },
  };
}
