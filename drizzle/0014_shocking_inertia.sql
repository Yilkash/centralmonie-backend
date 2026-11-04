CREATE TABLE "agent_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"daily_limit_kobo" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agent_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "agent_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key_id" uuid NOT NULL,
	"status" text DEFAULT 'quoted' NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"usdc_minor" bigint NOT NULL,
	"pay_in_minor" bigint NOT NULL,
	"bank_name" text NOT NULL,
	"account_number" text NOT NULL,
	"account_name" text NOT NULL,
	"pay_from" text NOT NULL,
	"refund_to" text NOT NULL,
	"quote_expires_at" timestamp with time zone NOT NULL,
	"payout_address" text,
	"payout_kobo" bigint,
	"deposit_address" text,
	"deposit_deadline" timestamp with time zone,
	"transactions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_payments" ADD CONSTRAINT "agent_payments_key_id_agent_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."agent_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_payments_key_idx" ON "agent_payments" USING btree ("key_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_payments_status_idx" ON "agent_payments" USING btree ("status");