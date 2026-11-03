CREATE TYPE "public"."schedule_run_status" AS ENUM('started', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."schedule_status" AS ENUM('proposed', 'awaiting_signature', 'active', 'completed', 'cancelled', 'failed', 'rejected', 'expired');--> statement-breakpoint
CREATE TABLE "op_switches" (
	"name" text PRIMARY KEY NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" "schedule_run_status" DEFAULT 'started' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"status" "schedule_status" DEFAULT 'proposed' NOT NULL,
	"timing" jsonb NOT NULL,
	"route" "payment_route" NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_detail" text NOT NULL,
	"destination" jsonb NOT NULL,
	"data_plan" text,
	"amount_kobo" bigint NOT NULL,
	"fixed_usdc_minor" bigint,
	"scheduled_for" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"runs_left" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"reminded_for" timestamp with time zone,
	"permission" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "schedule_group_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "cancel_schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "schedule_run_id" uuid;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_runs_due_idx" ON "schedule_runs" USING btree ("schedule_id","due_at");--> statement-breakpoint
CREATE INDEX "schedules_user_idx" ON "schedules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "schedules_group_idx" ON "schedules" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "schedules" USING btree ("status","next_run_at");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_schedule_run_id_unique" UNIQUE("schedule_run_id");