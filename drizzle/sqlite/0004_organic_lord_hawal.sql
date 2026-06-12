CREATE TABLE `bundle_docs` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`name` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`autoload` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`bundle_id`) REFERENCES `bundles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bundle_docs_bundle_name_idx` ON `bundle_docs` (`bundle_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `bundles_space_name_idx` ON `bundles` (`space_id`,`name`);--> statement-breakpoint
CREATE INDEX `files_bundle_idx` ON `files` (`bundle_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `hooks_bundle_name_idx` ON `hooks` (`bundle_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `item_types_bundle_name_idx` ON `item_types` (`bundle_id`,`name`);--> statement-breakpoint
CREATE INDEX `items_bundle_idx` ON `items` (`bundle_id`);--> statement-breakpoint
CREATE INDEX `items_item_type_idx` ON `items` (`item_type_id`);--> statement-breakpoint
CREATE INDEX `properties_item_type_idx` ON `properties` (`item_type_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_docs_user_name_idx` ON `user_docs` (`user_id`,`name`);