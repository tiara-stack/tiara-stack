CREATE TABLE IF NOT EXISTS "sheet_apis_dispatch_jobs" (
	"dispatch_request_id" text PRIMARY KEY,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"operation" text NOT NULL,
	"status" text NOT NULL,
	"run_id" text,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "sheet_apis_dispatch_jobs_status_updated_at_idx"
	ON "sheet_apis_dispatch_jobs" ("status", "updated_at");

ALTER TABLE "sheet_apis_dispatch_jobs"
	ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
