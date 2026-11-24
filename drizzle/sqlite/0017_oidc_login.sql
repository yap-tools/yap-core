CREATE TABLE `oidc_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`state_hash` text NOT NULL,
	`provider` text NOT NULL,
	`purpose` text NOT NULL,
	`context` text NOT NULL,
	`nonce` text NOT NULL,
	`code_verifier` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`called_back_at` text,
	`user_id` text,
	`ticket_hash` text,
	`ticket_expires_at` text,
	`used_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_transactions_state_idx` ON `oidc_transactions` (`state_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_transactions_ticket_idx` ON `oidc_transactions` (`ticket_hash`);--> statement-breakpoint
CREATE INDEX `oidc_transactions_expires_idx` ON `oidc_transactions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `user_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_issuer_subject_idx` ON `user_identities` (`issuer`,`subject`);--> statement-breakpoint
CREATE INDEX `user_identities_user_idx` ON `user_identities` (`user_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_oauth_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`key_id` text,
	`scope` text NOT NULL,
	`code_challenge` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`expires_at` text NOT NULL,
	`grant_expires_at` text,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`key_id`) REFERENCES `access_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_oauth_codes`("id", "code_hash", "client_id", "user_id", "key_id", "scope", "code_challenge", "redirect_uri", "expires_at") SELECT "id", "code_hash", "client_id", "user_id", "key_id", "scope", "code_challenge", "redirect_uri", "expires_at" FROM `oauth_codes`;--> statement-breakpoint
DROP TABLE `oauth_codes`;--> statement-breakpoint
ALTER TABLE `__new_oauth_codes` RENAME TO `oauth_codes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_codes_code_hash_idx` ON `oauth_codes` (`code_hash`);--> statement-breakpoint
CREATE TABLE `__new_oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`key_id` text,
	`client_id` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text NOT NULL,
	`expires_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`key_id`) REFERENCES `access_keys`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_oauth_grants`("id", "user_id", "key_id", "client_id", "scope", "created_at", "last_used_at") SELECT "id", "user_id", "key_id", "client_id", "scope", "created_at", "last_used_at" FROM `oauth_grants`;--> statement-breakpoint
DROP TABLE `oauth_grants`;--> statement-breakpoint
ALTER TABLE `__new_oauth_grants` RENAME TO `oauth_grants`;--> statement-breakpoint
CREATE INDEX `oauth_grants_user_idx` ON `oauth_grants` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauth_grants_key_idx` ON `oauth_grants` (`key_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `email` text;--> statement-breakpoint
CREATE INDEX `users_email_idx` ON `users` (`email`);