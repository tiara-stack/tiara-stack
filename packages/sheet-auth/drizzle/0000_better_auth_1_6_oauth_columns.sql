ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "auth_time" timestamp;
--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "require_pkce" boolean;
--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "subject_type" text;
