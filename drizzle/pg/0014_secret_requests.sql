CREATE TABLE "secret_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"bundle_id" text NOT NULL,
	"service_id" text NOT NULL,
	"paths" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"used_at" text
);
--> statement-breakpoint
ALTER TABLE "secret_requests" ADD CONSTRAINT "secret_requests_bundle_id_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."bundles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_requests" ADD CONSTRAINT "secret_requests_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_requests" ADD CONSTRAINT "secret_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "secret_requests_service_idx" ON "secret_requests" USING btree ("service_id");