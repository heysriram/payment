const assert = require('node:assert/strict');
const test = require('node:test');
const OTPAuth = require('otpauth');

const { calculateFee } = require('../dist/services/fees');
const { generateTotpSecret } = require('../dist/utils/crypto');
const { requireScope } = require('../dist/middleware/auth');

const feePlan = {
  percentBps: 200,
  fixedPaise: 300,
  intlPercentBps: 350,
};

test('domestic and international fees use their respective rates', () => {
  assert.equal(calculateFee(10000, feePlan, false), 500);
  assert.equal(calculateFee(10000, feePlan, true), 650);
});

test('generated TOTP secrets are valid base32', () => {
  for (let index = 0; index < 1000; index += 1) {
    const secret = generateTotpSecret();
    assert.doesNotThrow(() => OTPAuth.Secret.fromBase32(secret));
  }
});

test('scope middleware rejects keys without the required scope', () => {
  const middleware = requireScope('payments:write');
  let error;
  middleware({ scopes: ['tokenize'] }, {}, (value) => {
    error = value;
  });
  assert.equal(error.statusCode, 403);
});
