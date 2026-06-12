import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';
import { logger } from './logger';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Zod validation errors (request body shape wrong)
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Invalid request parameters',
        errors: err.errors.map((e) => ({
          param: e.path.join('.'),
          message: e.message,
        })),
      },
    });
    return;
  }

  // Our typed app errors
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error({ err }, err.message);
    }
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.param && { param: err.param }),
      },
    });
    return;
  }

  // Unexpected errors — don't leak internals to the client
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'An unexpected error occurred',
    },
  });
}