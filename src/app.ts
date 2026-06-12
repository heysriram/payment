import express from 'express';
import { httpLogger } from './middleware/logger';
import { errorHandler } from './middleware/error';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { merchantRouter } from './routes/merchants';
import { apiKeyRouter } from './routes/apiKeys';
import { customerRouter } from './routes/customers';
import { paymentMethodRouter } from './routes/paymentMethods';
import { paymentIntentRouter } from './routes/paymentIntents';
import { config } from './config';

export function createApp(): express.Application {
  const app = express();

  app.use(express.json({ limit: '10kb' }));
  app.use(httpLogger);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  const v1 = `/api/${config.API_VERSION}`;

  app.use('/api',          healthRouter);
  app.use(`${v1}/auth`,    authRouter);
  app.use(`${v1}/merchants`, merchantRouter);
  app.use(`${v1}/api-keys`,  apiKeyRouter);
  app.use(`${v1}/customers`, customerRouter);
  app.use(`${v1}/payment_methods`, paymentMethodRouter);
  app.use(`${v1}/payment_intents`, paymentIntentRouter);

  app.use((_req, res) => {
    res.status(404).json({
      error: { code: 'not_found', message: 'Route not found' },
    });
  });

  app.use(errorHandler);
  return app;
}