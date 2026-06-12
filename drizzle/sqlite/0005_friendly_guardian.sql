INSERT INTO `bundle_docs` (`id`, `bundle_id`, `name`, `content`, `autoload`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), `id`, 'instructions', `docs`, 1, `updated_at`, `updated_at`
FROM `bundles` WHERE `docs` <> '';--> statement-breakpoint
ALTER TABLE `bundles` DROP COLUMN `docs`;