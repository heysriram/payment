/**
 * Integration smoke against the assembled Express app — does NOT require
 * Postgres or Redis. The /health endpoint must answer regardless.
 *
 * The /ready endpoint does try to ping Postgres/Redis. We assert the response
 * shape only, so it returns either 200 or 503 depending on the runner.
 */

import request from 'supertest';
import { createApp } from '../../src/app';

describe('Express bootstrap', () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    app = createApp();
  });

  it('GET /api/health returns 200 ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('serves OpenAPI JSON', async () => {
    const res = await request(app).get('/api/payments/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(typeof res.body.paths['/payment_intents'].post).toBe('object');
  });

  it('exposes /metrics in Prometheus text format', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toMatch(/payments_http_requests_total/);
  });

  it('returns 404 with structured error on unknown routes', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});
