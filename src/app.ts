import express from 'express';
import helmet from 'helmet';
import hpp from 'hpp';
import { httpLogger } from './middleware/logger';
import { errorHandler } from './middleware/error';
import { metricsHandler, httpMetricsMiddleware } from './middleware/metrics';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { merchantRouter } from './routes/merchants';
import { apiKeyRouter } from './routes/apiKeys';
import { customerRouter } from './routes/customers';
import { paymentMethodRouter } from './routes/paymentMethods';
import { paymentIntentRouter } from './routes/paymentIntents';
import { webhookRouter } from './routes/webhooks';
import { eventRouter } from './routes/events';
import { docsRouter } from './routes/docs';
import { config } from './config';

export function createApp(): express.Application {
  const app = express();

  // Trust the first proxy (nginx / load balancer) so req.ip and rate limits
  // operate on the client IP rather than the LB IP.
  app.set('trust proxy', 1);

  // Security headers (helmet sets ~15 sensible defaults including CSP-lite,
  // HSTS, X-DNS-Prefetch-Control, etc.). We disable CSP because the Swagger
  // UI page loads its own scripts and styles inline.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );

  // Block HTTP Parameter Pollution (e.g. ?role=admin&role=viewer)
  app.use(hpp());

  app.use(express.json({ limit: '10kb' }));
  app.use(httpLogger);
  app.use(httpMetricsMiddleware);

  // Belt-and-braces alongside helmet
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  const v1 = `/api/${config.API_VERSION}`;

  // Operational endpoints — never under /v1 because they're not versioned.
  app.use('/api',          healthRouter);
  app.get('/metrics',      metricsHandler);
  app.use('/api/payments', docsRouter); // /api/payments/docs, /openapi.yaml, /openapi.json

  // Versioned API surface
  app.use(`${v1}/auth`,            authRouter);
  app.use(`${v1}/merchants`,       merchantRouter);
  app.use(`${v1}/api-keys`,        apiKeyRouter);
  app.use(`${v1}/customers`,       customerRouter);
  app.use(`${v1}/payment_methods`, paymentMethodRouter);
  app.use(`${v1}/payment_intents`, paymentIntentRouter);
  app.use(`${v1}/webhooks`,        webhookRouter);
  app.use(`${v1}/events`,          eventRouter);

  app.use((_req, res) => {
    res.status(404).json({
      error: { code: 'not_found', message: 'Route not found' },
    });
  });

  app.use(errorHandler);
  return app;
}
