CREATE TYPE "public"."contact_status" AS ENUM('proposed', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."destination_kind" AS ENUM('phone', 'bank', 'wallet');--> statement-breakpoint
CREATE TYPE "public"."payment_route" AS ENUM('airtime', 'data', 'bank', 'usdc');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('proposed', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TABLE "contact_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"kind" "destination_kind" NOT NULL,
	"phone" text,
	"network" text,
	"bank_name" text,
	"account_number" text,
	"account_name" text,
	"wallet_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"status" "contact_status" DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_item_id" uuid NOT NULL,
	"route" "payment_route" NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"usdc_minor" bigint NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"provider_reference" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_plan_item_id_unique" UNIQUE("plan_item_id")
);
--> statement-breakpoint
CREATE TABLE "plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"route" "payment_route" NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_detail" text NOT NULL,
	"destination" jsonb NOT NULL,
	"data_plan" text,
	"amount_kobo" bigint NOT NULL,
	"usdc_minor" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "plan_status" DEFAULT 'proposed' NOT NULL,
	"quote_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "contact_destinations" ADD CONSTRAINT "contact_destinations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_plan_item_id_plan_items_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."plan_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contacts_user_idx" ON "contacts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "payments_user_created_idx" ON "payments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "plans_user_idx" ON "plans" USING btree ("user_id");