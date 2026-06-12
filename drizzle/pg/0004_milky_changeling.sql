CREATE TABLE "bundle_docs" (
	"id" text PRIMARY KEY NOT NULL,
	"bundle_id" text NOT NULL,
	"name" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"autoload" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bundle_docs" ADD CONSTRAINT "bundle_docs_bundle_id_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."bundles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bundle_docs_bundle_name_idx" ON "bundle_docs" USING btree ("bundle_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "bundles_space_name_idx" ON "bundles" USING btree ("space_id","name");--> statement-breakpoint
CREATE INDEX "files_bundle_idx" ON "files" USING btree ("bundle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hooks_bundle_name_idx" ON "hooks" USING btree ("bundle_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "item_types_bundle_name_idx" ON "item_types" USING btree ("bundle_id","name");--> statement-breakpoint
CREATE INDEX "items_bundle_idx" ON "items" USING btree ("bundle_id");--> statement-breakpoint
CREATE INDEX "items_item_type_idx" ON "items" USING btree ("item_type_id");--> statement-breakpoint
CREATE INDEX "properties_item_type_idx" ON "properties" USING btree ("item_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_docs_user_name_idx" ON "user_docs" USING btree ("user_id","name");