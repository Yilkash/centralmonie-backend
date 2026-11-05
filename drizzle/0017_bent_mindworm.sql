CREATE TABLE "pay_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"bank_name" text NOT NULL,
	"account_number" text NOT NULL,
	"account_name" text NOT NULL,
	"note" text,
	"payment_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pay_links" ADD CONSTRAINT "pay_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_links" ADD CONSTRAINT "pay_links_payment_id_agent_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."agent_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pay_links_user_idx" ON "pay_links" USING btree ("user_id","created_at");