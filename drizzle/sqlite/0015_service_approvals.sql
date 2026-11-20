CREATE TABLE `service_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`service_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`decision` text,
	`decided_by` text,
	FOREIGN KEY (`bundle_id`) REFERENCES `bundles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `service_approvals_service_idx` ON `service_approvals` (`service_id`);--> statement-breakpoint
ALTER TABLE `secret_requests` ADD `submitted_by` text;--> statement-breakpoint
ALTER TABLE `services` ADD `approved_at` text;--> statement-breakpoint
ALTER TABLE `services` ADD `approved_by` text;--> statement-breakpoint
-- Every service written before approvals existed counts as approved.
UPDATE `services` SET `approved_at` = `updated_at`;
