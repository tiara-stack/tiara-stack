# Docker Compose Deployment

This Compose stack is for local development and single-machine smoke testing.
It runs Postgres, Redis, a local JWKS server, Zero cache, and the target sheet
runtime services from the existing package Dockerfiles.

## Setup

Generate local secrets:

```sh
pnpm compose:generate-secrets
```

`compose:generate-secrets` creates `deploy/compose/.env` using the same keys as
`.env.example`, fills generated password fields, and writes local secret files.
Then edit `deploy/compose/.env` and fill in the Discord and OAuth client values:

- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_TOKEN`
- `SHEET_BOT_OAUTH_CLIENT_ID`
- `SHEET_BOT_OAUTH_CLIENT_SECRET`
- `SHEET_WORKFLOWS_OAUTH_CLIENT_ID`
- `SHEET_WORKFLOWS_OAUTH_CLIENT_SECRET`

The generator emits empty OAuth placeholders on first setup so it can create the
environment file. Docker Compose validates all four values before starting a
service.

Optional local settings:

- `COOKIE_DOMAIN`: leave blank for localhost.
- `OTEL_EXPORTER_OTLP_ENDPOINT`: leave blank to use the bundled
  `local-otel-sink` service.
- `ZERO_ADMIN_PASSWORD`: optional for local Zero admin access; generated `.env`
  files fill a random value.

The npm script runs the generator with `--no-overwrite` so existing Postgres and
Redis passwords keep matching existing local volumes. To intentionally rotate
local database credentials, remove the Compose volumes and run
`pnpm tsx deploy/compose/scripts/generate-secrets.ts` directly. `tsx` is
provided by this repo's devDependencies.

`deploy/compose/scripts/generate-secrets.ts` creates a placeholder
`deploy/compose/secrets/google-service-account.json` so Docker Compose has a file
to bind-mount for workflow runner Google API operations. Replace that file with a
real Google service account JSON before using sheet operations that call Google
APIs. The script also writes
`google-service-account.json.placeholder` as a reference copy of the expected
shape.

## Run

The app Dockerfiles expect each package's `dist.tar.zst` to already exist.

```sh
pnpm build
docker compose --env-file deploy/compose/.env up -d postgres redis local-jwks local-otel-sink
pnpm compose:migrate-sheet-db
docker compose --env-file deploy/compose/.env build
docker compose --env-file deploy/compose/.env up
```

The migration helper runs `sheet-db-schema`'s Effect SQL migrations through
`effect-sql-kit` against the Compose Postgres instance exposed on
`POSTGRES_PORT`.

Public local URLs:

- Web app: `http://localhost:3001`
- Auth server: `http://localhost:3002`

Use a separate local Discord application with this redirect URL:

```text
http://localhost:3002/callback/discord
```

## Secret Model

Do not commit generated or real secret files. The repository ignores:

- `deploy/compose/.env`
- `deploy/compose/secrets/*`

`local-jwks` serves the generated public key to app services that exercise the
local service-account authorization path. Zero delegates bearer-token
verification to `sheet-db-server`, matching the production deployment.
