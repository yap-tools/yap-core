DROP INDEX `item_values_prop_value_idx`;--> statement-breakpoint
CREATE INDEX `item_values_prop_value_prefix_idx` ON `item_values` (`property_id`,substr(`value`, 1, 600));
