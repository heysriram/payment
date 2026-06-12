import Redis from 'ioredis';
import { config } from './config';

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times): number | null {
    if (times > 3) return null; // stop retrying, throw error
    return Math.min(times * 200, 1000);
  },
  lazyConnect: false,
});

redis.on('connect', () => {
  process.stdout.write('Redis connected\n');
});

redis.on('error', (err) => {
  process.stderr.write(`Redis error: ${err.message}\n`);
});
