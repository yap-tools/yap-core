CREATE TABLE "schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"bundle_id" text NOT NULL,
	"service_id" text NOT NULL,
	"action" text NOT NULL,
	"params" text DEFAULT '{}' NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"owner_id" text NOT NULL,
	"last_fired_at" text,
	"last_run_id" text,
	"last_error" text,
	"last_skipped_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "schedule_id" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_bundle_id_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."bundles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedules_bundle_idx" ON "schedules" USING btree ("bundle_id","created_at");--> statement-breakpoint
CREATE INDEX "schedules_service_idx" ON "schedules" USING btree ("service_id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_schedule_idx" ON "runs" USING btree ("schedule_id");