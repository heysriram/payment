-- Append-only event log
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "apiVersion" TEXT NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "events_merchantId_type_createdAt_idx"
    ON "events"("merchantId", "type", "createdAt");
CREATE INDEX "events_merchantId_createdAt_idx"
    ON "events"("merchantId", "createdAt");

ALTER TABLE "events"
    ADD CONSTRAINT "events_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "merchants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Block UPDATE/DELETE on events at the database level (append-only invariant)
CREATE OR REPLACE FUNCTION events_block_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'events table is append-only (% on row %)', TG_OP, OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_no_update
    BEFORE UPDATE ON "events"
    FOR EACH ROW EXECUTE FUNCTION events_block_mutation();

CREATE TRIGGER events_no_delete
    BEFORE DELETE ON "events"
    FOR EACH ROW EXECUTE FUNCTION events_block_mutation();

-- Webhook delivery: scheduling fields + retry-queue index
ALTER TABLE "webhook_deliveries"
    ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
    ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "webhook_deliveries"
    ADD CONSTRAINT "webhook_deliveries_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "events"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "webhook_deliveries_status_nextAttemptAt_idx"
    ON "webhook_deliveries"("status", "nextAttemptAt");
