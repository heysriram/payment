import { Request, Response, NextFunction } from 'express';
import client from 'prom-client';

// Default Node + process metrics: heap, GC, event-loop lag, etc.
client.collectDefaultMetrics({ prefix: 'payments_' });

const httpRequestsTotal = new client.Counter({
  name: 'payments_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
});

const httpRequestDurationSeconds = new client.Histogram({
  name: 'payments_http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status'],
  // Buckets tuned for an API where p95 should be < 1s and p99 < 3s
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const ledgerEntriesPosted = new client.Counter({
  name: 'payments_ledger_entries_posted_total',
  help: 'Number of ledger entries written (one per row)',
  labelNames: ['account', 'currency'],
});

export const webhookDeliveriesTotal = new client.Counter({
  name: 'payments_webhook_deliveries_total',
  help: 'Webhook delivery outcomes',
  labelNames: ['outcome'], // succeeded | failed | retrying
});

export const webhookDeliveryDurationSeconds = new client.Histogram({
  name: 'payments_webhook_delivery_duration_seconds',
  help: 'End-to-end webhook delivery latency',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});

/**
 * Express middleware: records request count + latency by route and status.
 * Routes are taken from the matched Express route to avoid label cardinality
 * blowup from path parameters.
 */
export function httpMetricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const route = req.route?.path
      ? `${req.baseUrl ?? ''}${req.route.path}`
      : req.path.split('/').slice(0, 4).join('/'); // fallback bucket
    const labels = {
      method: req.method,
      route,
      status: String(res.statusCode),
    };
    const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, elapsedSec);
  });
  next();
}

/** GET /metrics — Prometheus scrape target. */
export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.setHeader('Content-Type', client.register.contentType);
  res.send(await client.register.metrics());
}
