# Payments — Postman / Newman

End-to-end black-box tests against a running gateway. The collection is hand-curated against
[`openapi.yaml`](../openapi.yaml); regenerate with:

```bash
npx openapi-to-postmanv2 -s ../openapi.yaml -o payments.postman_collection.json -O folderStrategy=Tags
```

…then re-merge the test scripts.

## Run locally

```bash
# 1. Start Postgres + Redis
docker compose up -d

# 2. Apply migrations + seed
npm run db:migrate
npx prisma db seed

# 3. Start the API
npm run dev

# 4. Run the collection
npm run test:postman
```

Newman writes an HTML report to `newman-report.html` in the repo root.

## Environments

| File | Notes |
|------|-------|
| `environments/local.postman_environment.json` | `http://localhost:3000` (Vite proxy or direct) |
| `environments/sandbox.postman_environment.json` | UAT cluster |
| `environments/production.postman_environment.json` | Read-only; do **not** run mutating flows here |

## Flows covered

| Folder | Asserts |
|--------|---------|
| **1. Health & Docs** | `/health`, `/ready`, `/api/payments/openapi.json` |
| **2. Merchant Onboarding** | Register → login → partial JWT |
| **3. Customers & Payment Methods** | Create customer; attach token-only payment method (no PAN/CVV) |
| **4. Payment Intents** | Create with `Idempotency-Key`; **replay returns same intent (200)**; dummy SUCCESS confirm; partial refund |
| **5. Negative cases** | Missing idempotency key → 400; missing API key → 401 |

## CI

Newman runs after the API is up:

```yaml
- run: npm ci
- run: npm run build
- run: docker compose up -d postgres redis
- run: npx prisma migrate deploy
- run: npx prisma db seed
- run: npm start &
- run: npx wait-on http://localhost:3000/api/health
- run: npm run test:postman
```
