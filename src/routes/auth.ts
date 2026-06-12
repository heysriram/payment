import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { login, verifyTotp, verifyJwt } from '../services/auth';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const totpSchema = z.object({
  code: z.string().length(6).regex(/^\d+$/),
});

// POST /v1/auth/login
authRouter.post('/login', async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const result = await login(email, password);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /v1/auth/totp/verify
authRouter.post('/totp/verify', async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    // Extract userId from the partial JWT (pre-TOTP token)
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: { code: 'authentication_required', message: 'Missing token' } });
      return;
    }
    const payload = verifyJwt(authHeader.slice(7));
    const { code } = totpSchema.parse(req.body);
    const fullToken = await verifyTotp(payload.sub, code);
    res.json({ token: fullToken });
  } catch (err) {
    next(err);
  }
});