ALTER TABLE "hooks" RENAME TO "services";--> statement-breakpoint
ALTER TABLE "services" RENAME COLUMN "transport_encrypted" TO "config_encrypted";--> statement-breakpoint
ALTER TABLE "services" RENAME CONSTRAINT "hooks_bundle_id_bundles_id_fk" TO "services_bundle_id_bundles_id_fk";--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "driver" text DEFAULT 'http' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "pins" text DEFAULT '{}' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "hooks_bundle_name_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "services_bundle_name_idx" ON "services" USING btree ("bundle_id","name");--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"bundle_id" text NOT NULL,
	"service_id" text,
	"service_name" text NOT NULL,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"params" text DEFAULT '{}' NOT NULL,
	"result" text,
	"error" text,
	"error_code" text,
	"writes" text DEFAULT '[]' NOT NULL,
	"created_at" text NOT NULL,
	"started_at" text,
	"finished_at" text
);
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_bundle_id_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."bundles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_bundle_created_idx" ON "runs" USING btree ("bundle_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_service_created_idx" ON "runs" USING btree ("service_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_finished_idx" ON "runs" USING btree ("status","finished_at");--> statement-breakpoint
UPDATE "grants" SET "capability" = 'run_services' WHERE "capability" = 'fire_hooks';--> statement-breakpoint
UPDATE "grants" SET "capability" = 'edit_services' WHERE "capability" = 'edit_hooks';
