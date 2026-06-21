CREATE TABLE "agent_files" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"status" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"mime_type" text DEFAULT '' NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"storage_key" text NOT NULL,
	"upload_consumed" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"finalized_at" text
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"name" text NOT NULL,
	"runtime" text NOT NULL,
	"model" text NOT NULL,
	"args" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"schedule" text,
	"access_key_id" text NOT NULL,
	"access_key_encrypted" text NOT NULL,
	"output_path" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_files" ADD CONSTRAINT "agent_files_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_access_key_id_access_keys_id_fk" FOREIGN KEY ("access_key_id") REFERENCES "public"."access_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_files_agent_idx" ON "agent_files" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_space_name_idx" ON "agents" USING btree ("space_id","name");