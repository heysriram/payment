import {
  signPayload,
  verifySignature,
  parseSignature,
} from '../../src/services/webhooks';

const SECRET = 'whsec_test_a1b2c3d4e5f6';
const BODY = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });

describe('webhook signatures', () => {
  it('round-trips sign + verify', () => {
    const header = signPayload(BODY, SECRET);
    expect(verifySignature(BODY, header, SECRET)).toBe(true);
  });

  it('rejects when the body is tampered with', () => {
    const header = signPayload(BODY, SECRET);
    expect(verifySignature(BODY + 'X', header, SECRET)).toBe(false);
  });

  it('rejects when the secret is wrong', () => {
    const header = signPayload(BODY, SECRET);
    expect(verifySignature(BODY, header, 'whsec_other')).toBe(false);
  });

  it('rejects an old signature (replay protection)', () => {
    const sixMinutesAgo = Math.floor(Date.now() / 1000) - 6 * 60;
    const header = signPayload(BODY, SECRET, sixMinutesAgo);
    expect(verifySignature(BODY, header, SECRET)).toBe(false);
  });

  it('parses well-formed headers', () => {
    const header = signPayload(BODY, SECRET);
    const parsed = parseSignature(header);
    expect(parsed).not.toBeNull();
    expect(typeof parsed?.timestamp).toBe('number');
    expect(parsed?.v1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns null for malformed headers', () => {
    expect(parseSignature('not-a-signature')).toBeNull();
    expect(parseSignature('t=123')).toBeNull();
    expect(parseSignature('v1=abc')).toBeNull();
  });

  it('uses constant-time comparison (different-length signatures fail fast)', () => {
    expect(verifySignature(BODY, 't=1,v1=ab', SECRET)).toBe(false);
  });
});
