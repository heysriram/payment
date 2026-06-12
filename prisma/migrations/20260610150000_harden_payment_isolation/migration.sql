ALTER TYPE "LedgerAccount" ADD VALUE 'PROCESSOR' BEFORE 'AVAILABLE';

ALTER TABLE "payment_methods"
ADD COLUMN "isInternational" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "payment_intents"
ADD COLUMN "paymentMethodId" TEXT;

ALTER TABLE "payment_intents"
ADD CONSTRAINT "payment_intents_paymentMethodId_fkey"
FOREIGN KEY ("paymentMethodId") REFERENCES "payment_methods"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

DROP INDEX "payment_intents_idempotencyKey_key";
CREATE UNIQUE INDEX "payment_intents_merchantId_idempotencyKey_key"
ON "payment_intents"("merchantId", "idempotencyKey");
