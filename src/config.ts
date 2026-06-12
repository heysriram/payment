import 'dotenv/config';
import { z } from 'zod';

const positiveInteger = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive());
const nonPlaceholderSecret = z.string().min(32).refine(
  (value) => !/change[_-]?me|placeholder|xxxx/i.test(value),
  'Must not be a placeholder value'
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: positiveInteger.default('3000'),
  API_VERSION: z.string().default('v1'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_SECRET: nonPlaceholderSecret,
  JWT_EXPIRES_IN: z.string().default('30m'),

  RAZORPAY_KEY_ID: z.string(),
  RAZORPAY_KEY_SECRET: z.string(),

  ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),

  RATE_LIMIT_WINDOW_MS: positiveInteger.default('60000'),
  RATE_LIMIT_MAX_REQUESTS: positiveInteger.default('100'),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production') {
    for (const key of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'] as const) {
      if (!env[key] || /change[_-]?me|placeholder|xxxx/i.test(env[key])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'Must not be a placeholder value in production',
        });
      }
    }
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  process.stderr.write(`${JSON.stringify(parsed.error.flatten().fieldErrors)}\n`);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
