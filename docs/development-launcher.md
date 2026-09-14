# Development launcher

The root `pnpm dev` command is the single entrypoint for local development
mode selection. The launcher validates input, reads only mode-approved
configuration, and prints a safe process plan. Fast mode then starts the
planned `sheet-web` watch process and waits for its local URL to respond.

## Commands

```text
pnpm dev
pnpm dev fast
pnpm dev fast up
pnpm dev fast up --service sheet-auth
pnpm dev fast up --service sheet-db-server
pnpm dev fast up --service sheet-bot
pnpm dev compose <up|build|down|seed|reset>
pnpm dev kubernetes <validate|preview> [--changed-surface <surface>]
pnpm dev doctor
pnpm dev setup <fast|compose|kubernetes>
```

The bare command and a mode without an action print help and do no deployment,
process start, or destructive work. Compose reset requires
`--confirm`. Kubernetes preview requires `--tag <image-tag>` and
`--confirm-development`.

Every command accepts `--json` for the stable machine-readable result. Commands
that read a file accept `--env-file <path>`. A mode can restrict its process
plan with `--service <package-name>` in Fast or Compose mode. Kubernetes
preview always applies the complete development release. Repeat
`--changed-surface` for each affected surface: `http`, `backend-runtime`,
`packaging`, `environment-contract`, `secret-contract`, `database-schema`,
`zero-schema`, `authentication`, `workflow-api`, `workflow-storage`,
`workflow-actions`, `workflow-runner`, `browser-runner`, `chromium`,
`screenshot`, `browser-credentials`, `helm`, `ingress`, `network-policy`,
`persistence`, `cross-service`, `discord`, or `google-sheets`. The Effect CLI
also accepts a comma-separated value in one flag.

Fast reads `.env.development.local` from the repository root by default. Pass
`--env-file <path>` to use an explicit file. The default web slice accepts only
the four Fast URLs and `DEV_SHEET_WEB_PORT`. The explicitly selected auth and
database-server slices additionally accept their package configuration, but
only with host-reachable local Postgres, Redis, JWKS, and OTEL endpoints. The
workflow API slice additionally validates its selected role and runner topology.

Use `pnpm dev <mode> help` for mode-specific help. `--help` is reserved for
Effect CLI's generated root help.

## Mode matrix

| Mode | Runtime processes | Allowed origins | State boundary |
| --- | --- | --- | --- |
| Fast | `sheet-web` by default; explicitly selected `sheet-auth`, `sheet-db-server`, `sheet-workflows`, or `sheet-bot` on the host | web uses development HTTPS endpoints; backend slices use host-reachable local dependencies | shared Fast development sandbox |
| Compose | packaged runtime containers and local dependencies | loopback URLs only | the selected local Checkout State |
| Kubernetes | fixed development preview release | `*.dev.theerapakg.moe` endpoints | shared Kubernetes Development Sandbox |

Fast passes only these values to the planned `sheet-web` process:

```text
APP_BASE_URL
AUTH_BASE_URL
SHEET_ZERO_BASE_URL
SHEET_WORKFLOWS_BASE_URL
```

Database URLs, Redis URLs, service tokens, Google credentials, and Discord
credentials remain invalid for the web slice. Backend slices receive only the
package environment they need, and the launcher rejects production origins,
Compose-only DNS names, and mixed-mode values before startup.

Compose uses `deploy/compose/.env` by default. Generate it with
`pnpm compose:generate-secrets`. The existing commands remain available:

```text
pnpm compose:generate-secrets
pnpm compose:migrate-sheet-db
```

Kubernetes validation renders the existing chart with the development values.
Preview is fixed to release `tiara-stack-dev` in namespace `tiara-stack-dev`
and the development registry. Set `KUBE_CONTEXT=tiara-stack-dev` and pass
`--confirm-development` before preview. It cannot target production values
through the launcher configuration.

Preview promotion reports routine `api-evidence`, `helm-lint`, `helm-render`,
and `workload-readiness` gates. Changed surfaces add the applicable Compose,
API and ordinary-runner, workflow-contract, browser-runner, Kubernetes
invariant, Discord, or Google Sheets overlay. Every other overlay is reported
as `not-affected`. Required gates run in order and any non-zero result blocks
promotion. Discord and Google Sheets checks are explicit development-only
operations against dedicated resources and credentials; they are never part
of the default gate.

The current development Discord check uses the sole development guild and
channel `1466752705900056749`. It posts a uniquely marked probe message,
verifies the message, and deletes it. The Google Sheets check uses the
development service account mounted at `sheet-workflows-secret-path`, discovers
the associated spreadsheet through Drive, and reads only the bounded `A1:C3`
range. It does not write to the sheet.

`setup <mode>` is reserved for the mode-specific setup implementations. The
core command reports it as unavailable until those implementations land.

## Ports and output

The launcher uses deterministic assignments. The initial assignments include
port 3001 for `sheet-web`, 3002 for `sheet-auth`, 3003 for
`sheet-workflows`, 3004 for `sheet-db-server`, 3005 for `sheet-bot`, 4848 for Zero Cache, and 9464 for
Prometheus. An occupied
port is an error. The launcher never selects a random replacement.

Fast accepts deterministic overrides for `DEV_SHEET_WEB_PORT`,
`DEV_SHEET_AUTH_PORT`, `DEV_SHEET_DB_SERVER_PORT`, `DEV_SHEET_BOT_PORT`,
`DEV_SHEET_WORKFLOWS_PORT`, `DEV_PROMETHEUS_PORT`, and `DEV_LOCAL_JWKS_PORT`.
Explicitly selectable Fast
services are `sheet-web`, `sheet-auth`, `sheet-db-server`, `sheet-workflows`,
and `sheet-bot`. Local JWKS is exposed by Compose on port 8081 by
default for host-native processes. Port collisions fail before startup.

Host-native backend plans use package-local TypeScript paths and watch commands. Select the
workflow API explicitly with `--service sheet-workflows`:

```text
pnpm exec tsx watch --tsconfig tsconfig.json src/server.ts
pnpm exec tsx watch --tsconfig tsconfig.json src/index.ts
```

They use the checked-in source schema and migration artifacts and do not depend
on packaged Docker archives. Workflow host mode accepts `SHEET_WORKFLOWS_ROLE=api` or
`combined`; `runner` and `browser-runner` are rejected because those roles remain in
Compose or Kubernetes. `api` requires an ordinary runner available through the host topology at
`WORKFLOWS_RUNNER_HOST` and `WORKFLOWS_RUNNER_PORT` (localhost:34431 by default), and waits
for the ordinary runner fleet through `/ready`, while
`combined` runs the ordinary runner in the same source process. The launcher never starts
a separate runner process. Use `DEV_SHEET_WORKFLOWS_PORT` and, for `combined`,
`DEV_WORKFLOWS_RUNNER_PORT` for deterministic overrides.

The host-native sheet-bot is opt-in: `pnpm dev fast up --service sheet-bot`.
It requires `SHEET_BOT_DEV_DISCORD_TOKEN`, `SHEET_BOT_OAUTH_CLIENT_ID`,
`SHEET_BOT_OAUTH_CLIENT_SECRET`, and a
`SHEET_BOT_CAPABILITY_ENCRYPTION_SECRET` of at least 32 characters, plus
`REDIS_URL` pointing to the host-reachable local Redis service, such as
`redis://localhost:6379`. The launcher maps these dedicated
development credentials to the bot process and rejects `DISCORD_TOKEN` and
production origins. It wires the bot to host-reachable local auth, Zero cache,
workflow API, and web URLs, and waits for each dependency before reporting bot
readiness. Only one active gateway may use a given development Discord
credential; stop another host-native or Compose bot before starting this one.

`pnpm dev fast up` checks the approved auth, Zero, and Workflow endpoints with
bounded timeouts before starting `sheet-web`. It reports `readiness: ready`
after the application responds at its loopback URL, and keeps the Vite Plus
watch process attached to the terminal. An application startup failure or
readiness timeout is blocking and includes remediation.

Human and JSON output report the selected mode, action, services, planned
processes, URLs, readiness, warnings, and errors. Error records include a
stable category, the relevant mode and dependency, and a remediation. Secret
values never appear in output or process plans.

## Doctor

`pnpm dev doctor` runs short, read-only checks for Node, pnpm, vite-plus, Docker
Compose, Helm, kubectl, deterministic loopback ports, the development HTTP
dependencies, and the optional local observability sink. Required failures
block readiness. An observability failure is a warning and does not block the
doctor result. Every external command goes through the launcher process
executor with a bounded timeout.

The process executor is the replacement seam for tests and later mode
implementations. Core mode commands produce plans and leave execution to those
future adapters.
