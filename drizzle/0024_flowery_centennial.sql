CREATE TABLE "merchant_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"payout_bank_name" text,
	"payout_account_number" text,
	"payout_to_wallet" boolean DEFAULT false NOT NULL,
	"return_origins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"webhook_url" text,
	"webhook_secret" text,
	"invoices_per_day" integer DEFAULT 200 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "merchant_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "pay_links" ADD COLUMN "merchant_key_id" uuid;--> statement-breakpoint
ALTER TABLE "pay_links" ADD COLUMN "reference" text;--> statement-breakpoint
ALTER TABLE "pay_links" ADD COLUMN "return_url" text;--> statement-breakpoint
ALTER TABLE "merchant_events" ADD CONSTRAINT "merchant_events_key_id_merchant_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."merchant_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_events" ADD CONSTRAINT "merchant_events_link_id_pay_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."pay_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_keys" ADD CONSTRAINT "merchant_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_events_link_type_idx" ON "merchant_events" USING btree ("link_id","type");--> statement-breakpoint
CREATE INDEX "merchant_events_due_idx" ON "merchant_events" USING btree ("delivered_at","next_attempt_at");--> statement-breakpoint
ALTER TABLE "pay_links" ADD CONSTRAINT "pay_links_merchant_key_id_merchant_keys_id_fk" FOREIGN KEY ("merchant_key_id") REFERENCES "public"."merchant_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pay_links_merchant_reference_idx" ON "pay_links" USING btree ("merchant_key_id","reference");