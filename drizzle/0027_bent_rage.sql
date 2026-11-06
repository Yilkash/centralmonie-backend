CREATE TABLE "chain_deposits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"pay_from" text NOT NULL,
	"pay_token" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"quoted_minor" bigint NOT NULL,
	"refund_to" text NOT NULL,
	"deposit_address" text NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"received_minor" bigint,
	"transactions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_addresses" (
	"user_id" uuid NOT NULL,
	"family" text NOT NULL,
	"address" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_addresses_user_id_family_pk" PRIMARY KEY("user_id","family")
);
--> statement-breakpoint
ALTER TABLE "chain_deposits" ADD CONSTRAINT "chain_deposits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_addresses" ADD CONSTRAINT "refund_addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chain_deposits_user_idx" ON "chain_deposits" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "chain_deposits_status_idx" ON "chain_deposits" USING btree ("status");