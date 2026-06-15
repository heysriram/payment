import type { Config } from 'jest';

const baseEnv = {
  NODE_ENV: 'test',
  JWT_SECRET: 'test_jwt_secret_must_be_at_least_32_characters_long_for_zod_to_pass',
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  DATABASE_URL: 'postgresql://payments:payments_dev@localhost:5432/payments_db',
  REDIS_URL: 'redis://localhost:6379',
  RAZORPAY_KEY_ID: 'rzp_test_xx',
  RAZORPAY_KEY_SECRET: 'rzp_test_secret_xx',
  WEBHOOKS_RUN_INPROCESS: 'false',
};

for (const [key, value] of Object.entries(baseEnv)) {
  if (!process.env[key]) process.env[key] = value;
}

const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  preset: 'ts-jest',
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/server.ts',
    '!src/workers/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/unit/**/*.test.ts'],
      setupFiles: ['<rootDir>/test/jest.setup.ts'],
    },
    {
      displayName: 'integration',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/integration/**/*.test.ts'],
      setupFiles: ['<rootDir>/test/jest.setup.ts'],
    },
  ],
};

export default config;
