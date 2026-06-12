import { Request, Response, NextFunction } from 'express';
import { verifyJwt } from '../services/auth';
import { AuthenticationError, AuthorizationError } from '../utils/errors';

// Extend Express Request for JWT context
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userRole?: string;
      totpVerified?: boolean;
    }
  }
}

export function requireJwt(req: Request, _res: Response, next: NextFunction): void {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AuthenticationError();
    }
    const payload = verifyJwt(header.slice(7));
    req.userId       = payload.sub;
    req.merchantId   = payload.merchantId;
    req.userRole     = payload.role;
    req.totpVerified = (payload as { totpVerified?: boolean }).totpVerified ?? false;
    next();
  } catch (err) {
    next(err);
  }
}

// Require TOTP to have been completed
export function requireTotpVerified(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (!req.totpVerified) {
    next(new AuthorizationError('TOTP verification required'));
    return;
  }
  next();
}

// Require a specific dashboard role
export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.userRole || !roles.includes(req.userRole)) {
      next(new AuthorizationError('Insufficient role'));
      return;
    }
    next();
  };
}