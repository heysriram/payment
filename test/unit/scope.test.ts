import { requireScope } from '../../src/middleware/auth';
import type { Request, Response, NextFunction } from 'express';

function callMiddleware(scopes: string[] | undefined, required: string) {
  const req = { scopes } as Partial<Request> as Request;
  const res = {} as Response;
  let captured: unknown;
  const next: NextFunction = (err?: unknown) => {
    captured = err;
  };
  requireScope(required)(req, res, next);
  return captured as { statusCode?: number; code?: string } | undefined;
}

describe('requireScope', () => {
  it('passes through when the required scope is present', () => {
    const err = callMiddleware(['payments:write', 'tokenize'], 'payments:write');
    expect(err).toBeUndefined();
  });

  it('rejects with 403 when the scope is missing', () => {
    const err = callMiddleware(['tokenize'], 'payments:write');
    expect(err?.statusCode).toBe(403);
    expect(err?.code).toBe('authorization_error');
  });

  it('rejects when scopes is undefined', () => {
    const err = callMiddleware(undefined, 'payments:write');
    expect(err?.statusCode).toBe(403);
  });

  it('rejects when scopes is empty', () => {
    const err = callMiddleware([], 'payments:write');
    expect(err?.statusCode).toBe(403);
  });
});
