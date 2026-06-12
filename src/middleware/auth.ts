import { ApiKeyMode } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      merchantId?: string;
      apiKeyId?: string;
      keyMode?: ApiKeyMode;
      scopes?: string[];
    }
  }
}
import { Request, Response, NextFunction } from 'express';
import { verifyApiKey } from '../services/apiKey';
import { AuthenticationError, AuthorizationError } from '../utils/errors';

// Extract Bearer token from Authorization header
function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

// Require a valid API key — attaches merchant context to req
export async function requireApiKey(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      throw new AuthenticationError('Missing Authorization header');
    }

    const context = await verifyApiKey(token);

    req.merchantId = context.merchantId;
    req.apiKeyId   = context.keyId;
    req.keyMode    = context.mode;
    req.scopes     = context.scopes;

    next();
  } catch (err) {
    next(err);
  }
}

// Require LIVE mode key — blocks test keys from production endpoints
export function requireLiveMode(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (req.keyMode !== 'LIVE') {
    next(new AuthorizationError('This endpoint requires a live mode API key'));
    return;
  }
  next();
}

// Require a specific scope
export function requireScope(scope: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.scopes?.includes(scope)) {
      next(new AuthorizationError(`Missing required scope: ${scope}`));
      return;
    }
    next();
  };
}