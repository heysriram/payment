# Payment Gateway — On-call Runbook

> Audience: anyone with prod access on the payments rotation.
> Source of truth: this file. Update via PR; review with the EM.

## Quick links

| | |
|---|---|
| API base (prod) | `https://api.payments.example.com` |
| Health | `GET /api/health`, `GET /api/ready` |
| Metrics | `GET /metrics` (Prometheus scrape) |
| Logs | Datadog, index `service:payments-api` |
| Traces | Jaeger / Tempo, service `payments-api` |
| Grafana | `payments-overview` dashboard |
| Status | `https://status.example.com/payments` |

## Top alerts

### 1. `payments_http_5xx_burst`
Triggers when the 5xx rate over 1 min > 1%.

1. Open the Grafana panel and identify the failing route.
2. Tail logs: `service:payments-api status:>=500`.
3. If `internal_error` with no stack: check Sentry for the captured exception.
4. If concentrated on one route → consider rolling back via `kubectl rollout undo deployment/payments-api`.
5. If concentrated on one merchant → suspend their API key with `prisma.apiKey.update where revokedAt = now()` after EM approval.

### 2. `payments_db_unreachable`
Triggers when `/api/ready` returns 503 for more than 60 s.

1. Check the RDS status page.
2. `kubectl logs deploy/payments-api | grep "prisma"` for connection errors.
3. If RDS failover is in progress, the app reconnects automatically; no action.
4. If app pods are stuck, restart the rollout.

### 3. `payments_redis_unreachable`
Triggers when `/api/ready` shows `redis: error`.

* Rate limiting **fails open** — traffic is not blocked.
* Webhook worker pauses; deliveries pile up in Postgres but **are not lost**.
* The recovery sweep reschedules them once Redis is back.

### 4. `payments_webhook_failure_rate`
Triggers when `payments_webhook_deliveries_total{outcome="failed"}` rate > 5/min for 10 min.

1. Pull a sample failure: `prisma.webhookDelivery.findMany where status='FAILED' orderBy lastAttemptAt desc take 5`.
2. If it's one merchant URL → that merchant gets auto-set to `FAILING` by the worker. Notify them.
3. If it's many merchants → likely an outbound network issue. Check egress NAT / SG rules.

### 5. `payments_ledger_invariant_drift`
Triggers when the daily reconciliation job reports a non-zero difference between processor settlement file and our ledger.

1. Open the diff CSV from `s3://payments-recon/<date>.diff.csv`.
2. **Do not touch the ledger.** Open an INC ticket and page the EM. The ledger is append-only — corrections happen via compensating entries reviewed by Finance.

## Common operations

### Roll back the API
```bash
kubectl rollout undo deployment/payments-api -n payments
```
Mean rollback time: **< 5 min**.

### Replay events to a webhook
```bash
curl -XPOST https://api.payments.example.com/v1/webhooks/<id>/deliveries/<deliveryId>/retry \
  -H "Authorization: Bearer <admin_jwt>"
```

### Suspend a merchant
```sql
UPDATE merchants SET status = 'SUSPENDED' WHERE id = '<merchant_id>';
```
Existing API keys for that merchant will start returning 401 immediately (verified in `verifyApiKey`).

### Drain the webhook worker
```bash
kubectl scale deploy/payments-webhook-worker --replicas=0
# wait for in-flight jobs to finish (max 10 s timeout per delivery)
kubectl scale deploy/payments-webhook-worker --replicas=2
```

## Database migrations
* Migrations run via `prisma migrate deploy` from the deploy job.
* New migrations **must** be reviewed against the prod schema with `prisma migrate diff` before merge.
* Never `prisma migrate dev` on prod.

## Useful queries

```sql
-- Available balance per merchant (sanity check vs. /merchants/balance)
SELECT "merchantId", SUM(delta) AS available
FROM ledger
WHERE account = 'AVAILABLE' AND currency = 'INR'
GROUP BY "merchantId"
ORDER BY available DESC LIMIT 20;

-- Recent failed deliveries
SELECT wd.id, w.url, wd.attempts, wd."responseCode", e.type
FROM webhook_deliveries wd
JOIN webhooks w ON w.id = wd."webhookId"
JOIN events e ON e.id = wd."eventId"
WHERE wd.status = 'FAILED'
ORDER BY wd."lastAttemptAt" DESC
LIMIT 50;
```
