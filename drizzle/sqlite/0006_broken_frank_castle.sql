ALTER TABLE `hooks` RENAME TO `services`;--> statement-breakpoint
ALTER TABLE `services` RENAME COLUMN `transport_encrypted` TO `config_encrypted`;--> statement-breakpoint
ALTER TABLE `services` ADD `driver` text DEFAULT 'http' NOT NULL;--> statement-breakpoint
ALTER TABLE `services` ADD `pins` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `hooks_bundle_name_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `services_bundle_name_idx` ON `services` (`bundle_id`,`name`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`service_id` text,
	`service_name` text NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	`result` text,
	`error` text,
	`writes` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`bundle_id`) REFERENCES `bundles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `runs_bundle_created_idx` ON `runs` (`bundle_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_service_created_idx` ON `runs` (`service_id`,`created_at`);--> statement-breakpoint
UPDATE `grants` SET `capability` = 'run_services' WHERE `capability` = 'fire_hooks';--> statement-breakpoint
UPDATE `grants` SET `capability` = 'edit_services' WHERE `capability` = 'edit_hooks';
