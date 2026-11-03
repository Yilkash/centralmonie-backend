ALTER TYPE "public"."payment_status" ADD VALUE 'awaiting_signature';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'funding';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'funded';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'paying';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'returning';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'returned';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'needs_support';--> statement-breakpoint
CREATE TABLE "chain_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"from_address" text NOT NULL,
	"usdc_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funding_transactions" (
	"tx_hash" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "plan_item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "recipient_name" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "destination" jsonb;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "funding_address" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refundable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "funding_tx_hash" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "funding_from_block" bigint;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refund_tx_hash" text;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_tx_log_idx" ON "deposits" USING btree ("tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "deposits_user_idx" ON "deposits" USING btree ("user_id");