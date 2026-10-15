CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`service_id` text NOT NULL,
	`action` text NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	`cron` text NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`owner_id` text NOT NULL,
	`last_fired_at` text,
	`last_run_id` text,
	`last_error` text,
	`last_skipped_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`bundle_id`) REFERENCES `bundles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `schedules_bundle_idx` ON `schedules` (`bundle_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `schedules_service_idx` ON `schedules` (`service_id`);--> statement-breakpoint
ALTER TABLE `runs` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `source` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `schedule_id` text REFERENCES schedules(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `runs_schedule_idx` ON `runs` (`schedule_id`);