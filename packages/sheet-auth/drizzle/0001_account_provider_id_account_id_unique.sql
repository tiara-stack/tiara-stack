WITH ranked_accounts AS (
  SELECT
    "account".id,
    "account".user_id,
    ROW_NUMBER() OVER (
      PARTITION BY "account".provider_id, "account".account_id
      ORDER BY
        CASE
          WHEN "account".access_token IS NOT NULL OR "account".refresh_token IS NOT NULL THEN 0
          ELSE 1
        END,
        CASE
          WHEN "user".email LIKE 'discord\_%@oauth.internal' ESCAPE '\' THEN 1
          ELSE 0
        END,
        "account".created_at ASC,
        "account".id ASC
    ) AS duplicate_rank
  FROM "account"
  INNER JOIN "user" ON "user".id = "account".user_id
),
deleted_accounts AS (
  DELETE FROM "account"
  WHERE id IN (
    SELECT id
    FROM ranked_accounts
    WHERE duplicate_rank > 1
  )
  RETURNING user_id
)
DELETE FROM "user"
WHERE id IN (
  SELECT deleted_accounts.user_id
  FROM deleted_accounts
)
AND email LIKE 'discord\_%@oauth.internal' ESCAPE '\'
AND NOT EXISTS (
  SELECT 1
  FROM "account"
  WHERE "account".user_id = "user".id
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_provider_id_account_id_unique" ON "account" USING btree ("provider_id","account_id");
