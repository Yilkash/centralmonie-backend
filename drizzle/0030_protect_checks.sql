CREATE TABLE "protect_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"profile" text NOT NULL,
	"verdict" text NOT NULL,
	"serv_verdict" text,
	"summary" text,
	"question" text,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"refusal" text,
	"model" text,
	"ms" integer,
	"tokens" integer,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "protect_checks" ADD CONSTRAINT "protect_checks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "protect_checks_subject_idx" ON "protect_checks" USING btree ("subject_kind","subject_id","created_at");