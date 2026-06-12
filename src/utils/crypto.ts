import argon2 from 'argon2';
import crypto from 'crypto';
import { config } from '../config';

// Generate a cryptographically random string
export function generateRandomString(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

// Hash a secret (API key, password) with argon2
export async function hashSecret(secret: string): Promise<string> {
  return argon2.hash(secret, {
    type: argon2.argon2id,
    memoryCost: 2 ** 16, // 64 MB
    timeCost: 3,
    parallelism: 1,
  });
}
export function generateTotpSecret(): string {
  // 20 bytes → 32 base32 chars — valid TOTP secret length
  const bytes = crypto.randomBytes(20);
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let result = '';
  for (const byte of bytes) {
    result += base32Chars[byte % 32];
  }
  return result;
}
// Verify a plain secret against a stored hash
export async function verifySecret(
  plain: string,
  hash: string
): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

// Encrypt a value (used for TOTP secrets, KYC data)
export function encrypt(plaintext: string): string {
  const key = Buffer.from(config.ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:encrypted (all hex)
  return [
    iv.toString('hex'),
    tag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

// Decrypt a value
export function decrypt(ciphertext: string): string {
  const key = Buffer.from(config.ENCRYPTION_KEY, 'hex');
  const [ivHex, tagHex, encryptedHex] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}