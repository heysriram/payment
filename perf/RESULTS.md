# Performance test results

This file is the canonical home for documented load-test runs. Append a new
section per release; never overwrite older entries.

## How to update

```bash
# 1. Boot the gateway against a production-like dataset:
DATABASE_URL=... REDIS_URL=... npm run build && npm start &

# 2. Acquire a test secret key (one-time):
export SECRET_KEY=sk_test_xxx

# 3. Run k6:
BASE_URL=http://localhost:3000 SECRET_KEY=$SECRET_KEY \
  k6 run --out json=perf/k6-summary.json perf/k6-payments.js

# 4. Run Artillery:
BASE_URL=http://localhost:3000 \
  npx artillery run -o perf/artillery-report.json perf/artillery-checkout.yml
npx artillery report perf/artillery-report.json

# 5. Paste the headline numbers into the table below and commit.
```

## NFR thresholds (from BRD § PAYM-13 / PAYM-16)

| Operation                   | Target p95 | Target p99 | Hard cap (5xx error rate) |
|-----------------------------|-----------:|-----------:|--------------------------:|
| Payment authorisation       | ≤ 3 000 ms | ≤ 5 000 ms |                  ≤ 0.50 % |
| Balance / list lookup       |  ≤   50 ms |  ≤  120 ms |                  ≤ 0.10 % |
| Dashboard load (last 30 d)  | ≤ 2 000 ms | ≤ 4 000 ms |                  ≤ 0.50 % |
| Webhook delivery (worker)   | ≤ 1 000 ms | ≤ 3 000 ms |                  ≤ 1.00 % |
| Refund issuance             | ≤ 4 000 ms | ≤ 8 000 ms |                  ≤ 0.50 % |
| Aggregate ledger query      | ≤ 1 500 ms | ≤ 3 000 ms |                  ≤ 0.50 % |

## Run log

### YYYY-MM-DD — vX.Y.Z (template — copy this block per run)

- **Run host**: e.g. AWS m6i.2xlarge, 8 vCPU, 32 GiB RAM
- **Driver host**: laptop / k6-cloud / dedicated runner
- **Dataset**: e.g. 10 000 merchants, 1 M payment intents, 5 webhooks/merchant
- **Network path**: same VPC / over public internet / via API gateway
- **Build SHA**: `git rev-parse HEAD`
- **k6 command**: as above
- **Artillery command**: as above

| Metric                                | Target  | Measured | Pass? |
|---------------------------------------|--------:|---------:|:-----:|
| `pg_intent_create_ms` p95             | < 3 000 |          |       |
| `pg_intent_create_ms` p99             | < 5 000 |          |       |
| `http_req_duration{name:create}` mean |       — |          |   —   |
| `pg_error_rate`                       |  < 1 %  |          |       |
| Artillery scenario completion rate    | ≥ 99 %  |          |       |
| Artillery `http.codes.500` count      |     0   |          |       |

#### Notes / regressions

- _Describe any anomalies, hot indexes that surfaced, GC pauses, etc._

#### Action items

- [ ] _e.g. add covering index on `events(merchantId, type, createdAt)`_
- [ ] _e.g. tune Postgres `random_page_cost` for SSD-backed RDS_

---

### 2026-06-15 — baseline (placeholder, replace before first release)

Run not yet performed. The baseline run is required by PAYM-16 acceptance
criteria before the first production deployment.
