import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { generateApiKey, listApiKeys, revokeApiKey } from '../services/apiKey';
import { requireJwt, requireTotpVerified, requireRole } from '../middleware/jwtAuth';
import { prisma } from '../db';
import { AuthorizationError } from '../utils/errors';

export const apiKeyRouter = Router();

// All API key management requires JWT + TOTP + OWNER/ADMIN role
apiKeyRouter.use(requireJwt, requireTotpVerified, requireRole('OWNER', 'ADMIN'));

const createKeySchema = z.object({
  mode: z.enum(['TEST', 'LIVE']),
  scopes: z.array(z.enum([
    'payments:write',
    'payments:read',
    'refunds:write',
    'refunds:read',
    'customers:write',
    'customers:read',
    'tokenize',
  ])).min(1),
  isSecret: z.boolean().default(true),
}).superRefine((data, ctx) => {
  if (!data.isSecret && (data.scopes.length !== 1 || data.scopes[0] !== 'tokenize')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scopes'],
      message: 'Public keys may only use the tokenize scope',
    });
  }
});

// POST /v1/api-keys — create a new key
apiKeyRouter.post('/', async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { mode, scopes, isSecret } = createKeySchema.parse(req.body);
    if (mode === 'LIVE') {
      const merchant = await prisma.merchant.findUnique({
        where: { id: req.merchantId! },
        select: { status: true },
      });
      if (merchant?.status !== 'APPROVED') {
        throw new AuthorizationError('Live API keys require an approved merchant');
      }
    }
    const { record, fullKey } = await generateApiKey(
      req.merchantId!,
      mode,
      scopes,
      isSecret
    );

    res.status(201).json({
      id: record.id,
      keyId: record.keyId,
      mode: record.mode,
      scopes: record.scopes,
      createdAt: record.createdAt,
      // Only returned once
      secret: fullKey,
      note: 'Save this key — it will not be shown again.',
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/api-keys — list all keys
apiKeyRouter.get('/', async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const keys = await listApiKeys(req.merchantId!);
    res.json({ data: keys, count: keys.length });
  } catch (err) {
    next(err);
  }
});

// DELETE /v1/api-keys/:id — revoke
apiKeyRouter.delete('/:id', async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    await revokeApiKey(req.params.id, req.merchantId!);
    res.status(200).json({ revoked: true });
  } catch (err) {
    next(err);
  }
});
