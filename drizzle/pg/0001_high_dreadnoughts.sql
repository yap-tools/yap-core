ALTER TABLE "item_values" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "multi" integer DEFAULT 0 NOT NULL;