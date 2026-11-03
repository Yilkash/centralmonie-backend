ALTER TABLE "chat_messages" ADD COLUMN "tx_hash" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "last_tx_hash" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "last_paid_at" timestamp with time zone;