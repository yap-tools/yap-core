CREATE TABLE `runtime_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`runtime` text NOT NULL,
	`blob_encrypted` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_credentials_runtime_unique` ON `runtime_credentials` (`runtime`);