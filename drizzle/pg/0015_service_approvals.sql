CREATE TABLE "service_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"bundle_id" text NOT NULL,
	"service_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"used_at" text,
	"decision" text,
	"decided_by" text
);
--> statement-breakpoint
ALTER TABLE "secret_requests" ADD COLUMN "submitted_by" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "approved_at" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "service_approvals" ADD CONSTRAINT "service_approvals_bundle_id_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."bundles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_approvals" ADD CONSTRAINT "service_approvals_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_approvals" ADD CONSTRAINT "service_approvals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_approvals_service_idx" ON "service_approvals" USING btree ("service_id");--> statement-breakpoint
-- Every service written before approvals existed counts as approved.
UPDATE "services" SET "approved_at" = "updated_at";
