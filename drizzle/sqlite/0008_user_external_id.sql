ALTER TABLE `users` ADD `external_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_external_id_idx` ON `users` (`external_id`);