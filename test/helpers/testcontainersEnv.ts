/**
 * Spins up Postgres + Redis in disposable Docker containers, applies the
 * Prisma migrations, seeds the default fee plan, and rewrites
 * `process.env.DATABASE_URL` / `process.env.REDIS_URL` so that the rest of the
 * codebase (which reads them at module-load time) connects to the test
 * instances.
 *
 * Usage:
 *   import { setupTestEnv, teardownTestEnv } from '../helpers/testcontainersEnv';
 *
 *   beforeAll(async () => { ctx = await setupTestEnv(); }, 120_000);
 *   afterAll(async () => { await teardownTestEnv(ctx); });
 *
 * NB: The first run pulls ~150 MB of images. Subsequent runs use the local
 * Docker cache.
 */

import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';

export interface TestEnv {
  postgres: StartedPostgreSqlContainer;
  redis: StartedRedisContainer;
  databaseUrl: string;
  redisUrl: string;
}

export async function setupTestEnv(): Promise<TestEnv> {
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('payments_test')
      .withUsername('payments')
      .withPassword('payments_test')
      .start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  const databaseUrl = postgres.getConnectionUri();
  const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL = redisUrl;

  // Run Prisma migrations against the throwaway DB.
  // We use `migrate deploy` (not `dev`) so it never prompts.
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    cwd: path.resolve(__dirname, '../..'),
    stdio: 'inherit',
  });

  // Seed the default fee plan; merchants/register depends on it existing.
  execSync('npx prisma db seed', {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    cwd: path.resolve(__dirname, '../..'),
    stdio: 'inherit',
  });

  return { postgres, redis, databaseUrl, redisUrl };
}

export async function teardownTestEnv(env: TestEnv | undefined): Promise<void> {
  if (!env) return;
  // stop in parallel; tolerate failures so one stop won't mask the other
  await Promise.allSettled([env.postgres.stop(), env.redis.stop()]);
}
