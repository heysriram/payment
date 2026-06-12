import jwt from 'jsonwebtoken';
import * as OTPAuth from 'otpauth';
import { prisma } from '../db';
import { redis } from '../redis';
import { config } from '../config';
import {
  hashSecret,
  verifySecret,
  encrypt,
  decrypt,
  generateTotpSecret,
} from '../utils/crypto';
import {
  AuthenticationError,
  ValidationError,
} from '../utils/errors';

// ─── Constants ────────────────────────────────────────────────────

const LOCKOUT_ATTEMPTS = 5;
const LOCKOUT_TTL_SEC  = 15 * 60; // 15 minutes
const TOTP_SETUP_TTL   = 60 * 10; // 10 minutes to complete TOTP setup

// ─── Types ────────────────────────────────────────────────────────

interface LoginResult {
  token: string;
  requiresTotp: boolean;
  totpUri?: string; // only returned on first login before TOTP is configured
}

export interface JwtPayload {
  sub: string;          // userId
  merchantId: string;
  role: string;
  totpVerified: boolean;
  iat: number;
  exp: number;
}

// ─── Lockout helpers ──────────────────────────────────────────────

async function getFailedAttempts(userId: string): Promise<number> {
  const val = await redis.get(`auth:failed:${userId}`);
  return val ? parseInt(val, 10) : 0;
}

async function incrementFailedAttempts(userId: string): Promise<void> {
  const key = `auth:failed:${userId}`;
  await redis.incr(key);
  await redis.expire(key, LOCKOUT_TTL_SEC);
}

async function clearFailedAttempts(userId: string): Promise<void> {
  await redis.del(`auth:failed:${userId}`);
}

// ─── Login ────────────────────────────────────────────────────────

export async function login(
  email: string,
  password: string
): Promise<LoginResult> {

  // Look up user by email with their merchant link
  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      merchantUsers: {
        take: 1,
        select: {
          merchantId: true,
          role: true,
        },
      },
    },
  });

  // Always run a hash verification even if user not found
  // This prevents timing attacks that reveal whether an email exists
  const dummyHash = '$argon2id$v=19$m=65536,t=3,p=1$dummysaltdummysalt$dummyhash';
  if (!user || !user.merchantUsers.length) {
    await verifySecret(password, dummyHash).catch(() => {});
    throw new AuthenticationError('Invalid email or password');
  }

  const merchantUser = user.merchantUsers[0];

  // Check if account is locked out
  const attempts = await getFailedAttempts(user.id);
  if (attempts >= LOCKOUT_ATTEMPTS) {
    throw new AuthenticationError(
      'Account locked due to too many failed attempts. Try again in 15 minutes.'
    );
  }

  // Verify password
  const valid = await verifySecret(password, user.passwordHash);
  if (!valid) {
    await incrementFailedAttempts(user.id);
    const remaining = LOCKOUT_ATTEMPTS - (attempts + 1);
    throw new AuthenticationError(
      remaining > 0
        ? `Invalid email or password. ${remaining} attempt(s) remaining.`
        : 'Account locked due to too many failed attempts. Try again in 15 minutes.'
    );
  }

  // Password correct — clear any failed attempts
  await clearFailedAttempts(user.id);

  // Issue a partial JWT — not fully authenticated until TOTP is verified
  const token = jwt.sign(
    {
      sub: user.id,
      merchantId: merchantUser.merchantId,
      role: merchantUser.role,
      totpVerified: false,
    },
    config.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: config.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
  );

  // If TOTP not set up yet, generate a setup URI for the user to scan
  if (!user.totpSecret) {
    const rawSecret = generateTotpSecret();
    const totp = new OTPAuth.TOTP({
      issuer: 'PaymentGateway',
      label: user.email,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(rawSecret),
    });

    // Store the secret temporarily in Redis until user confirms with a code
    await redis.setex(
      `totp:setup:${user.id}`,
      TOTP_SETUP_TTL,
      encrypt(rawSecret)
    );

    return {
      token,
      requiresTotp: true,
      totpUri: totp.toString(), // merchant scans this with Google Authenticator
    };
  }

  return {
    token,
    requiresTotp: true,
  };
}

// ─── TOTP verification ────────────────────────────────────────────

export async function verifyTotp(
  userId: string,
  code: string
): Promise<string> {

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      merchantUsers: {
        take: 1,
        select: {
          merchantId: true,
          role: true,
        },
      },
    },
  });

  if (!user || !user.merchantUsers.length) {
    throw new AuthenticationError('User not found');
  }

  const merchantUser = user.merchantUsers[0];
  let secret: string;
  let isFirstSetup = false;

  if (!user.totpSecret) {
    // First-time setup — retrieve pending secret from Redis
    const pending = await redis.get(`totp:setup:${userId}`);
    if (!pending) {
      throw new ValidationError(
        'TOTP setup expired. Please log in again to get a new QR code.'
      );
    }
    secret = decrypt(pending);
    isFirstSetup = true;
  } else {
    // Existing setup — decrypt stored secret
    secret = decrypt(user.totpSecret);
  }

  // Validate the TOTP code
  // window: 1 allows one period (30s) of clock drift either side
  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });

  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) {
    throw new AuthenticationError('Invalid or expired TOTP code');
  }

  // First time — persist the encrypted secret to the DB
  if (isFirstSetup) {
    await prisma.user.update({
      where: { id: userId },
      data: { totpSecret: encrypt(secret) },
    });
    await redis.del(`totp:setup:${userId}`);
  }

  // Issue a fully authenticated JWT with totpVerified: true
  const fullToken = jwt.sign(
    {
      sub: userId,
      merchantId: merchantUser.merchantId,
      role: merchantUser.role,
      totpVerified: true,
    },
    config.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: config.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
  );

  return fullToken;
}

// ─── JWT verification ─────────────────────────────────────────────

export function verifyJwt(token: string): JwtPayload {
  try {
    return jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new AuthenticationError('Session expired. Please log in again.');
    }
    throw new AuthenticationError('Invalid session token.');
  }
}

// ─── Password change ──────────────────────────────────────────────

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) throw new AuthenticationError();

  const valid = await verifySecret(currentPassword, user.passwordHash);
  if (!valid) {
    throw new AuthenticationError('Current password is incorrect');
  }

  if (currentPassword === newPassword) {
    throw new ValidationError('New password must be different from current password');
  }

  const newHash = await hashSecret(newPassword);

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: newHash },
  });

  // Invalidate all active sessions by clearing any lockout state
  await clearFailedAttempts(userId);
}

// ─── TOTP disable (e.g. lost authenticator) ───────────────────────

export async function disableTotp(
  userId: string,
  password: string
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) throw new AuthenticationError();

  // Require password re-confirmation before disabling 2FA
  const valid = await verifySecret(password, user.passwordHash);
  if (!valid) {
    throw new AuthenticationError('Password confirmation failed');
  }

  await prisma.user.update({
    where: { id: userId },
    data: { totpSecret: null },
  });

  // Clear any pending setup in Redis too
  await redis.del(`totp:setup:${userId}`);
}
