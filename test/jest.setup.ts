// Jest globals setup. Loaded once before each test suite.
// Keep this file lightweight — heavy fixtures go in `test/helpers/*`.
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.JWT_SECRET ??=
  'test_jwt_secret_must_be_at_least_32_characters_long_for_zod_to_pass';
process.env.ENCRYPTION_KEY ??=
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_URL ??=
  'postgresql://payments:payments_dev@localhost:5432/payments_db';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.RAZORPAY_KEY_ID ??= 'rzp_test_xx';
process.env.RAZORPAY_KEY_SECRET ??= 'rzp_test_secret_xx';
process.env.WEBHOOKS_RUN_INPROCESS ??= 'false';

jest.setTimeout(15_000);
