import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import { redis } from '../redis';

export const healthRouter = Router();

// /health — is the process alive?
healthRouter.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// /ready — are all dependencies reachable?
healthRouter.get('/ready', async (_req: Request, res: Response) => {
  const checks: Record<string, 'ok' | 'error'> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.postgres = 'ok';
  } catch {
    checks.postgres = 'error';
  }

  try {
    await redis.ping();
    checks.redis = 'ok';
  } catch {
    checks.redis = 'error';
  }

  const allHealthy = Object.values(checks).every((v) => v === 'ok');

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'ready' : 'not_ready',
    checks,
  });
});