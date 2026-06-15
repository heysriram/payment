# API Documentation

Source of truth: [`/openapi.yaml`](../../openapi.yaml) at the repo root.

## Files in this directory

| File | Purpose |
|------|---------|
| `openapi.bundled.yaml` | Single-file bundle produced by `npx @redocly/cli bundle`. Used by the SDK generators, by client teams who want one file to import, and by tooling that doesn't follow `$ref`s well. |
| `CHANGELOG.md` *(generated)* | Diff between the previous release's bundled spec and the current one. |

## Regenerating the bundle

```bash
# inside the repo root
npm install            # one-time
npm run docs:lint      # redocly lint — fail-fast schema validation
npm run docs:bundle    # writes docs/api/openapi.bundled.yaml
```

Commit `docs/api/openapi.bundled.yaml` whenever the public API changes. CI
verifies the checked-in bundle is up-to-date — see
`.github/workflows/payments.yml` job `docs-drift`.

## Previewing the docs

```bash
npm run docs:preview   # serves Redoc on http://localhost:8080
```

Or visit the live Swagger UI at `http://localhost:3000/api/payments/docs`
when the gateway is running.

## SDK generation

```bash
npm run sdk:generate:ts        # TypeScript fetch client
npm run sdk:generate:python    # Python client
npm run sdk:generate:php       # PHP client
npm run sdk:generate:ruby      # Ruby client
npm run sdk:generate:all
```

Generated SDKs land under `sdk/<lang>/` and should be published to the
respective package registries through the `release-sdks` GitHub Action
(triggered manually after the spec lands on `main`).
