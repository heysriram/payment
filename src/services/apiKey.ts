import { ApiKeyMode } from '@prisma/client';
import { prisma } from '../db';
import { hashSecret, verifySecret, generateRandomString } from '../utils/crypto';
import { AuthenticationError, NotFoundError } from '../utils/errors';

export type KeyPrefix = 'sk_test' | 'sk_live' | 'pk_test' | 'pk_live';

export interface GeneratedKey {
  keyId: string;       // stored in DB — public identifier
  secret: string;      // returned ONCE to merchant, never stored plain
  fullKey: string;     // keyId + secret combined — what merchant uses in requests
}

interface ApiKeyContext {
  merchantId: string;
  keyId: string;
  mode: ApiKeyMode;
  scopes: string[];
}

// Build the key prefix based on mode and type
function getPrefix(mode: ApiKeyMode, isSecret: boolean): KeyPrefix {
  const modeStr = mode === 'LIVE' ? 'live' : 'test';
  const typeStr = isSecret ? 'sk' : 'pk';
  return `${typeStr}_${modeStr}` as KeyPrefix;
}

// Generate a new API key pair
// Returns the full key once — caller must store it, we only keep the hash
export async function generateApiKey(
  merchantId: string,
  mode: ApiKeyMode,
  scopes: string[],
  isSecret = true
): Promise<{ record: Awaited<ReturnType<typeof prisma.apiKey.create>>; fullKey: string }> {
  if (!isSecret && (scopes.length !== 1 || scopes[0] !== 'tokenize')) {
    throw new AuthenticationError('Public API keys may only use the tokenize scope');
  }
  const prefix = getPrefix(mode, isSecret);

  // keyId is the public identifier stored in DB
  // secret is the random part — hashed before storage
  const keyId = `${prefix}_${generateRandomString(16)}`;
  const secret = generateRandomString(32);
  const fullKey = `${keyId}_${secret}`;
  const keyHash = await hashSecret(secret);

  const record = await prisma.apiKey.create({
    data: {
      merchantId,
      keyId,
      keyHash,
      scopes,
      mode,
    },
  });

  return { record, fullKey };
}

// Verify an incoming API key from a request header
// Returns the merchant context if valid, throws if not
export async function verifyApiKey(fullKey: string): Promise<ApiKeyContext> {
  // Key format: prefix_randomId_secret
  // We split on last underscore to get keyId and secret
  const lastUnderscore = fullKey.lastIndexOf('_');
  if (lastUnderscore === -1) {
    throw new AuthenticationError('Invalid API key format');
  }

  const keyId = fullKey.substring(0, lastUnderscore);
  const secret = fullKey.substring(lastUnderscore + 1);

  // Look up by keyId (not secret — the secret is hashed)
  const apiKey = await prisma.apiKey.findUnique({
    where: { keyId },
    select: {
      id: true,
      merchantId: true,
      keyHash: true,
      mode: true,
      scopes: true,
      revokedAt: true,
      merchant: { select: { status: true } },
    },
  });

  if (!apiKey) {
    throw new AuthenticationError('Invalid API key');
  }

  if (apiKey.revokedAt) {
    throw new AuthenticationError('API key has been revoked');
  }
  if (apiKey.merchant.status === 'SUSPENDED') {
    throw new AuthenticationError('Merchant account is suspended');
  }
  if (apiKey.mode === 'LIVE' && apiKey.merchant.status !== 'APPROVED') {
    throw new AuthenticationError('Live API key is not active');
  }

  // Constant-time comparison via argon2 verify
  const valid = await verifySecret(secret, apiKey.keyHash);
  if (!valid) {
    throw new AuthenticationError('Invalid API key');
  }

  // Update last used timestamp (fire and forget — don't await)
  prisma.apiKey.update({
    where: { keyId },
    data: { lastUsedAt: new Date() },
  }).catch(() => {/* non-critical */});

  return {
    merchantId: apiKey.merchantId,
    keyId: apiKey.id,
    mode: apiKey.mode,
    scopes: Array.isArray(apiKey.scopes)
      ? apiKey.scopes.filter((scope): scope is string => typeof scope === 'string')
      : [],
  };
}

// Revoke a key — soft delete with timestamp
export async function revokeApiKey(
  keyId: string,
  merchantId: string
): Promise<void> {
  const key = await prisma.apiKey.findFirst({
    where: { id: keyId, merchantId },
  });

  if (!key) {
    throw new NotFoundError('API key');
  }

  await prisma.apiKey.update({
    where: { id: keyId },
    data: { revokedAt: new Date() },
  });
}

// List keys for a merchant — never returns hashes or secrets
export async function listApiKeys(merchantId: string): Promise<{
  id: string;
  keyId: string;
  mode: ApiKeyMode;
  scopes: string[];
  lastUsedAt: Date | null;
  createdAt: Date;
  isRevoked: boolean;
}[]> {
  const keys = await prisma.apiKey.findMany({
    where: { merchantId },
    select: {
      id: true,
      keyId: true,
      mode: true,
      scopes: true,
      lastUsedAt: true,
      createdAt: true,
      revokedAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  return keys.map((k) => ({
    id: k.id,
    keyId: k.keyId,
    mode: k.mode,
    scopes: Array.isArray(k.scopes)
      ? k.scopes.filter((scope): scope is string => typeof scope === 'string')
      : [],
    lastUsedAt: k.lastUsedAt,
    createdAt: k.createdAt,
    isRevoked: k.revokedAt !== null,
  }));
}
