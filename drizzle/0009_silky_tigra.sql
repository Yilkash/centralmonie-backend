CREATE TYPE "public"."naira_deposit_status" AS ENUM('waiting', 'processing', 'completed', 'failed', 'expired', 'cancelled');--> statement-breakpoint
CREATE TABLE "naira_deposits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"usdc_minor" bigint NOT NULL,
	"rate" text NOT NULL,
	"bank_name" text,
	"account_number" text NOT NULL,
	"account_name" text,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "naira_deposit_status" DEFAULT 'waiting' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "naira_deposits" ADD CONSTRAINT "naira_deposits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "naira_deposits_user_idx" ON "naira_deposits" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "naira_deposits_one_waiting_idx" ON "naira_deposits" USING btree ("user_id") WHERE "naira_deposits"."status" = 'waiting';