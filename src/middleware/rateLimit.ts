import { Request, Response, NextFunction } from 'express';
import { redis } from '../redis';
import { config } from '../config';
import { RateLimitError } from '../utils/errors';

interface RateLimitOptions {
  windowMs?: number;
  maxRequests?: number;
}

// Token bucket rate limiter using Redis
// Key: ratelimit:{keyId} — separate bucket per API key
export function rateLimit(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? config.RATE_LIMIT_WINDOW_MS;
  const maxRequests = options.maxRequests ?? config.RATE_LIMIT_MAX_REQUESTS;
  const windowSec = Math.ceil(windowMs / 1000);

  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    // Use API key ID if authenticated, fall back to IP
    const identifier = req.apiKeyId ?? req.ip ?? 'unknown';
    const key = `ratelimit:${identifier}`;

    try {
      // Lua script for atomic increment + expiry
      // Returns current count after increment
      const luaScript = `
        local current = redis.call('INCR', KEYS[1])
        if current == 1 then
          redis.call('EXPIRE', KEYS[1], ARGV[1])
        end
        return current
      `;

      const count = await redis.eval(
        luaScript,
        1,
        key,
        windowSec.toString()
      ) as number;

      // Set rate limit headers on every response
      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - count));
      res.setHeader('X-RateLimit-Reset', Date.now() + windowMs);

      if (count > maxRequests) {
        res.setHeader('Retry-After', windowSec);
        next(new RateLimitError());
        return;
      }

      next();
    } catch {
      // If Redis is down, fail open — don't block legitimate traffic
      next();
    }
  };
}