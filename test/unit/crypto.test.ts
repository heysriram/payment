import * as OTPAuth from 'otpauth';
import {
  encrypt,
  decrypt,
  generateRandomString,
  generateTotpSecret,
  hashSecret,
  verifySecret,
} from '../../src/utils/crypto';

describe('crypto utils', () => {
  describe('encrypt/decrypt (AES-256-GCM)', () => {
    it('round-trips arbitrary plaintext', () => {
      for (const plain of ['', 'hello', 'a'.repeat(2048), 'üñíçødé 🛡️']) {
        expect(decrypt(encrypt(plain))).toBe(plain);
      }
    });

    it('produces a different ciphertext on every call (random IV)', () => {
      const a = encrypt('same');
      const b = encrypt('same');
      expect(a).not.toBe(b);
    });

    it('rejects tampered ciphertext (auth tag mismatch)', () => {
      const ct = encrypt('secret');
      const [iv, tag, body] = ct.split(':');
      // Flip a bit in the encrypted body
      const tamperedBody = (parseInt(body[0], 16) ^ 0x1).toString(16) + body.slice(1);
      expect(() => decrypt([iv, tag, tamperedBody].join(':'))).toThrow();
    });
  });

  describe('generateTotpSecret', () => {
    it('produces 1000 valid base32 secrets', () => {
      for (let i = 0; i < 1000; i++) {
        const s = generateTotpSecret();
        expect(() => OTPAuth.Secret.fromBase32(s)).not.toThrow();
      }
    });
  });

  describe('hashSecret/verifySecret (argon2id)', () => {
    it('verifies the correct secret', async () => {
      const hash = await hashSecret('correct horse battery staple');
      expect(await verifySecret('correct horse battery staple', hash)).toBe(true);
    });

    it('rejects the wrong secret', async () => {
      const hash = await hashSecret('a-secret');
      expect(await verifySecret('not-the-secret', hash)).toBe(false);
    });
  });

  describe('generateRandomString', () => {
    it('returns base64url with the right entropy', () => {
      const s = generateRandomString(16);
      expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(s.length).toBeGreaterThanOrEqual(20); // base64url(16 bytes) ≈ 22 chars
    });
  });
});
