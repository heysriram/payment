# syntax=docker/dockerfile:1.7

# ─── Stage 1: deps ──────────────────────────────────────────────────
# Install full dev + prod deps so we can build TypeScript.
FROM node:20-bookworm-slim AS deps

WORKDIR /app

# argon2 needs a C toolchain at build time; the resulting binary is copied
# verbatim to the runtime image so we don't need gcc there.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

# ─── Stage 2: build ─────────────────────────────────────────────────
FROM deps AS build

COPY tsconfig.json ./
COPY src ./src
COPY openapi.yaml ./

RUN npx prisma generate \
 && npm run build

# ─── Stage 3: prune to production deps ──────────────────────────────
FROM deps AS prod-deps

ENV NODE_ENV=production
RUN npm prune --omit=dev

# ─── Stage 4: runtime ───────────────────────────────────────────────
# Distroless = no shell, no apt, smaller attack surface.
FROM gcr.io/distroless/nodejs20-debian12:nonroot AS runtime

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY --from=prod-deps --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=build     --chown=nonroot:nonroot /app/dist ./dist
COPY --from=build     --chown=nonroot:nonroot /app/openapi.yaml ./openapi.yaml
COPY --from=build     --chown=nonroot:nonroot /app/prisma ./prisma
COPY --chown=nonroot:nonroot package.json ./package.json

USER nonroot
EXPOSE 3000

# Start the API. Run the webhook worker as a separate deployment using
# CMD ["dist/workers/webhookWorker.js"].
CMD ["dist/server.js"]
