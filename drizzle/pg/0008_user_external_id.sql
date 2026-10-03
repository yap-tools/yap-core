ALTER TABLE "users" ADD COLUMN "external_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_external_id_idx" ON "users" USING btree ("external_id");