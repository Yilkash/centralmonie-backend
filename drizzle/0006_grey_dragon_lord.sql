ALTER TABLE "funding_transactions" ADD COLUMN "wallet" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "funding_transactions" ALTER COLUMN "wallet" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "funding_transactions" DROP CONSTRAINT "funding_transactions_pkey";--> statement-breakpoint
ALTER TABLE "funding_transactions" ADD CONSTRAINT "funding_transactions_tx_hash_wallet_pk" PRIMARY KEY("tx_hash","wallet");
