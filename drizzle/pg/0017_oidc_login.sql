CREATE TABLE "oidc_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"state_hash" text NOT NULL,
	"provider" text NOT NULL,
	"purpose" text NOT NULL,
	"context" text NOT NULL,
	"nonce" text NOT NULL,
	"code_verifier" text NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"called_back_at" text,
	"user_id" text,
	"ticket_hash" text,
	"ticket_expires_at" text,
	"used_at" text
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_codes" ALTER COLUMN "key_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_grants" ALTER COLUMN "key_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD COLUMN "grant_expires_at" text;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "expires_at" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "oidc_transactions" ADD CONSTRAINT "oidc_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_transactions_state_idx" ON "oidc_transactions" USING btree ("state_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_transactions_ticket_idx" ON "oidc_transactions" USING btree ("ticket_hash");--> statement-breakpoint
CREATE INDEX "oidc_transactions_expires_idx" ON "oidc_transactions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_issuer_subject_idx" ON "user_identities" USING btree ("issuer","subject");--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");