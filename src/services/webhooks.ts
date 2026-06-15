import crypto from 'node:crypto';
import { encrypt, decrypt } from '../utils/crypto';

/**
 * Webhook signature scheme — Stripe-compatible.
 *
 *   Header: `X-Payments-Signature: t=<unix_ts>,v1=<hex_hmac_sha256>`
 *
 *   Signed payload = `${unix_ts}.${request_body}`
 *   v1            = HMAC_SHA256(secret, signed_payload).hexDigest()
 *
 * Verification (5-min tolerance) compares with `crypto.timingSafeEqual`.
 */

export interface WebhookSignatureParts {
  timestamp: number;
  v1: string;
}

const SIGNATURE_HEADER = 'X-Payments-Signature';
const DEFAULT_TOLERANCE_SEC = 5 * 60;

export function signPayload(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signedPayload = `${timestamp}.${rawBody}`;
  const v1 = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

export function parseSignature(header: string): WebhookSignatureParts | null {
  const out: Partial<WebhookSignatureParts> = {};
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't' && v) out.timestamp = Number(v);
    if (k === 'v1' && v) out.v1 = v;
  }
  if (typeof out.timestamp !== 'number' || !out.v1) return null;
  return out as WebhookSignatureParts;
}

export function verifySignature(
  rawBody: string,
  header: string,
  secret: string,
  toleranceSec = DEFAULT_TOLERANCE_SEC
): boolean {
  const parsed = parseSignature(header);
  if (!parsed) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - parsed.timestamp) > toleranceSec) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parsed.timestamp}.${rawBody}`)
    .digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(parsed.v1, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Generate, encrypt, and return a webhook secret.
 * The plaintext is returned ONCE to the merchant; only the ciphertext is persisted.
 */
export function generateWebhookSecret(): { plaintext: string; ciphertext: string } {
  const plaintext = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
  return { plaintext, ciphertext: encrypt(plaintext) };
}

export function decryptWebhookSecret(ciphertext: string): string {
  return decrypt(ciphertext);
}

export const WEBHOOK_SIGNATURE_HEADER = SIGNATURE_HEADER;
