ALTER TABLE "agent_payments" ADD COLUMN "pay_token" text DEFAULT 'USDC' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_payments" ADD COLUMN "deliver_to" text;--> statement-breakpoint
ALTER TABLE "pay_links" ADD COLUMN "due_date" text;--> statement-breakpoint
ALTER TABLE "pay_links" ADD COLUMN "line_items" jsonb;--> statement-breakpoint
ALTER TABLE "pay_links" ADD COLUMN "near_account" text;