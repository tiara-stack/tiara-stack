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
Redis passwords keep matching existing local volumes. `pnpm dev compose` derives
a Docker Compose project name from the absolute source-checkout path and passes
it explicitly. Compose's project-prefixed volumes therefore form one isolated
Checkout State per checkout.

To intentionally rotate local database credentials, stop every process using the
selected Checkout State, run `pnpm dev compose reset --confirm`, then explicitly
run `pnpm tsx deploy/compose/scripts/generate-secrets.ts` to overwrite the local
credential files before setup. Reset itself preserves credentials, removes only
the selected Compose project's local volumes, and never touches Discord,
OAuth-provider registrations, Google Sheets, or service-account resources.

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
pnpm dev setup compose
pnpm dev compose build
pnpm dev compose up
pnpm dev compose seed
```

`compose up` never builds implicitly. If a package archive is missing, it stops
before Docker starts and tells you to run `pnpm dev compose build`.
`compose down` preserves the selected Checkout State; `compose reset --confirm`
is the destructive operation and reports its local scope.
Run `compose seed` after `compose up` and migrations when deterministic
Development Seed data is explicitly needed.

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
