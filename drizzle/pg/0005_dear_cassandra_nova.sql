INSERT INTO "bundle_docs" ("id", "bundle_id", "name", "content", "autoload", "created_at", "updated_at")
SELECT gen_random_uuid()::text, "id", 'instructions', "docs", 1, "updated_at", "updated_at"
FROM "bundles" WHERE "docs" <> '';--> statement-breakpoint
ALTER TABLE "bundles" DROP COLUMN "docs";