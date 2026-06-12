import pinoHttp from 'pino-http';
import pino from 'pino';
import { config } from '../config';

export const logger = pino({
  level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  ...(config.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  }),
});

export const httpLogger = pinoHttp({
  logger,
  customLogLevel(_req, res) {
    if (res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  // Never log sensitive headers
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie'],
    censor: '[REDACTED]',
  },
  serializers: {
    req(req) {
      return {
        id: req.id,
        method: req.method,
        url: req.url,
        merchant_id: req.raw.merchantId ?? undefined,
      };
    },
  },
});