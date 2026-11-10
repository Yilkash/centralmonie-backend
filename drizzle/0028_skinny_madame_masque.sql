CREATE TABLE "product_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"bank_name" text NOT NULL,
	"account_number" text NOT NULL,
	"account_name" text NOT NULL,
	"near_account" text,
	"usdc_address" text,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pay_links" ADD COLUMN "product_link_id" uuid;--> statement-breakpoint
ALTER TABLE "product_links" ADD CONSTRAINT "product_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_links_user_idx" ON "product_links" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "pay_links" ADD CONSTRAINT "pay_links_product_link_id_product_links_id_fk" FOREIGN KEY ("product_link_id") REFERENCES "public"."product_links"("id") ON DELETE set null ON UPDATE no action;