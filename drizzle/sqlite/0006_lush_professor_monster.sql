CREATE TABLE `agent_files` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`status` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`mime_type` text DEFAULT '' NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`storage_key` text NOT NULL,
	`upload_consumed` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`finalized_at` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_files_agent_idx` ON `agent_files` (`agent_id`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`name` text NOT NULL,
	`runtime` text NOT NULL,
	`model` text NOT NULL,
	`args` text DEFAULT '' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`schedule` text,
	`access_key_id` text NOT NULL,
	`access_key_encrypted` text NOT NULL,
	`output_path` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`access_key_id`) REFERENCES `access_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_space_name_idx` ON `agents` (`space_id`,`name`);