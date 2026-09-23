# Development launcher

The root `pnpm dev` command is the single entrypoint for local development
mode selection. The launcher validates input, reads only mode-approved
configuration, and prints a safe process plan. Every executable mode action
then uses the shared execution operation with the validated plan context. Fast
mode starts the selected host-native process and waits for its HTTP GET `/ready`
endpoint to return a 2xx response. Compose applications and Kubernetes gates
use their mode-specific usability checks through the same lifecycle contract.

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
pnpm dev preview <plan|doctor|start> --config <file>
pnpm dev preview <status|resume|stop|cleanup> --session <id>
pnpm dev doctor
pnpm dev setup <fast|compose|kubernetes>
```

The bare command and a mode without an action print help and do no deployment,
process start, or destructive work. Compose reset requires
`--confirm`. Kubernetes preview requires `--tag <image-tag>` and
`--confirm-development`.

Every command accepts `--json` for the stable machine-readable result. Mode
actions and connected preview actions also accept `--json-stream` for opt-in
JSON Lines lifecycle events. These output selections are mutually exclusive.
Commands that support environment files accept `--env-file <path>`; connected
preview commands reject that option and read their versioned configuration
through `--config <file>`. A mode can restrict its process plan with
`--service <package-name>` in Fast or Compose mode. Kubernetes preview always
applies the complete development release. Repeat
`--changed-surface` for each affected surface: `http`, `backend-runtime`,
`packaging`, `environment-contract`, `secret-contract`, `database-schema`,
`zero-schema`, `authentication`, `workflow-api`, `workflow-storage`,
`workflow-actions`, `workflow-runner`, `browser-runner`, `chromium`,
`screenshot`, `browser-credentials`, `helm`, `ingress`, `network-policy`,
`persistence`, `cross-service`, `discord`, or `google-sheets`. The Effect CLI
also accepts a comma-separated value in one flag.

`--config <file>` and `--session <id>` are reserved for connected preview
commands. Plan, doctor, and start require `--config`; status, resume, stop, and
cleanup require `--session`. The bare `pnpm dev preview` command prints help
without reading a file or starting a process.

Fast reads `.env.development.local` from the repository root by default. Pass
`--env-file <path>` to use an explicit file. The default web slice accepts only
the four Fast URLs and `DEV_SHEET_WEB_PORT`. The explicitly selected auth and
database-server slices additionally accept their package configuration, but
only with host-reachable local Postgres, Redis, JWKS, and OTEL endpoints. The
workflow API slice additionally validates its selected role and runner topology.

Use `pnpm dev <mode> help` for mode-specific help. `--help` is reserved for
Effect CLI's generated root help.

## Connected preview planning

The connected preview command family plans a separate, session-scoped runtime
topology. Its current implementation reads a versioned JSON configuration and
computes selected roles, required callers, dependency groups, compatibility,
declared intent, and admission prerequisites. Plan performs no allocation,
registration, migration, or external operation.

The repository-owned runtime catalog records each role's provided and consumed
contracts, state groups, external effects, allowed environment keys, positive
credential names, and co-selection requirements. The seven role selectors are
`sheet-web`, `sheet-auth`, `sheet-db-server`,
`sheet-bot`, `sheet-workflows-api`, `sheet-workflows-runner`, and
`sheet-workflows-browser-runner`. Workflow API, ordinary runner, and browser
runner remain distinct selectors. Shared libraries are compatibility inputs,
not runtime roles.

Every dependency group needed by the selected role closure needs an explicit
`owned` or `reused` choice. An owned group names an allocation profile. A
reused group names its development endpoint, state identity, and deployed
manifest digest. Reused endpoints must use a development HTTPS origin or an
approved private development hostname. Public endpoints use `https` or `wss`
on `dev.theerapakg.moe` or its subdomains. Private endpoints may use `https`,
`wss`, `postgres`, `postgresql`, `redis`, or `rediss` only on
`*.tiara-stack-dev.svc.cluster.local`. Paths must be empty or `/`. Endpoints
cannot contain user info, query strings, fragments, or production markers.
Duplicate reused origins block the plan.

Each selected role declares its artifact digest. Each relevant runtime
contract has a `compatible` or `incompatible` declaration tied to the same
source revision, role artifact, deployed manifest, and catalog version.
`implementation-only` declarations use `contract: null`. Missing, stale, and
unknown declarations block the plan. The launcher never classifies changes by
scanning file diffs. Incompatible contracts add their required callers and
owned groups to the report. The configuration must select those callers and
groups explicitly.

Every selected role names its environment input file relative to the preview
config. The file must exist under the same config directory. The planner reads
only `NODE_ENV=development` and an optional `LOG_LEVEL` of `debug`, `info`,
`warn`, or `error`; it reports file paths, allowed keys, and a digest, never
values. Credentials use positive, role-specific names from the runtime catalog
and `secret://tiara-stack-dev/<role>/<name>` references. Whole-pod environment
or credential imports are rejected.
Plan and doctor report credential-like ambient variables as redacted warnings;
the planner does not consume them. Remove them before a live profile can be
enabled.

The plan reports each dependency group's capacity dimensions with requested,
reserved, and available values marked unavailable. External targets report
their declared or exclusive ownership intent with verification unavailable.
These facts are admission requirements, not reservations or proof of capacity
and ownership.

The configuration schema is version 1. This example plans the auth role with
an owned auth group. Replace the sample commit and digests with the identities
for the source and development manifest under review.

```json
{
  "schemaVersion": 1,
  "environment": "tiara-stack-dev",
  "profile": "connected-preview-dev-v1",
  "owner": "developer:alice",
  "roles": ["sheet-auth"],
  "environmentFileInputs": [
    { "role": "sheet-auth", "path": "environment/sheet-auth.env" }
  ],
  "identities": {
    "sourceRevision": "0123456789abcdef0123456789abcdef01234567",
    "artifactDigests": {
      "sheet-auth": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    "deployedManifestDigest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "catalogVersion": 1
  },
  "groups": [
    {
      "id": "auth",
      "ownership": "owned",
      "allocationProfile": "auth-development-v1"
    }
  ],
  "changes": [
    {
      "role": "sheet-auth",
      "contract": "auth.session",
      "classification": "compatible",
      "sourceRevision": "0123456789abcdef0123456789abcdef01234567",
      "artifactDigest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "deployedManifestDigest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "catalogVersion": 1
    }
  ],
  "credentialReferences": {
    "sheet-auth": {
      "auth-sql": "secret://tiara-stack-dev/sheet-auth/auth-sql"
    }
  },
  "sharedExecution": "disabled"
}
```

Credential fields contain development secret references only. The launcher does
not resolve or print referenced secret values. Additional user grants default to
none. Triggers and external targets default to none. `seed` is optional and is
accepted only with an owned `application-zero` group. Selecting `sheet-bot`
requires an explicit target allocation and acknowledgment that the shared bot
will be unavailable during handoff. These fields record intent; plan does not
perform those operations.

`pnpm dev preview plan --config <file>` returns `readiness: planned` when the
configuration passes static validation. A planned result is not a reservation,
readiness proof, or admission decision. `pnpm dev preview doctor --config
<file>` reports current prerequisite checks as `unavailable` because the
workspace, controller, route, identity, grant, capacity, and cleanup probes are
not implemented. It never reports an unrun check as passed.

`start`, `status`, `resume`, `stop`, and `cleanup` return a blocked
`not-implemented` result. They do not read session state or invoke a process.
No connected profile is available for live use in this slice. Plans retain the
launcher JSON `schemaVersion: 3` and lifecycle JSON Lines `eventVersion: 1`.

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

Compose `up` waits for the existing infrastructure healthchecks, runs
migrations, and attaches to the selected application containers. The launcher
checks every selected application with HTTP GET `/ready` from inside its
container. The Docker `/live` healthcheck only proves that the process is alive
and never satisfies Development Readiness. This probe does not add or require
host ports for services that do not publish one.

Kubernetes validation renders the existing chart with the development values.
Preview is fixed to release `tiara-stack-dev` in namespace `tiara-stack-dev`
and the development registry. Set `KUBE_CONTEXT=tiara-stack-dev` and pass
`--confirm-development` before preview. It cannot target production values
through the launcher configuration.

Validation runs strict Helm lint and render steps only. Preview runs its
required gates in plan order, applies the fixed development release, then runs
the selected changed-surface overlays. A successful finite action reports
`readiness: completed`; a failed gate reports `readiness: blocked` and does not
run later gates. The launcher copies at most bounded, redacted workload details
after a preview failure.

Interrupting Kubernetes validation or preview stops the local command that is
running and reports the action as incomplete. It never issues rollback,
deletion, or teardown commands for the shared preview. Inspect the shared
development namespace before continuing.

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

In human output, Compose reports readiness after every selected application is
ready and stays attached until the command exits or receives a signal. In
`--json` mode, it writes one readiness document to stdout at that point. Child
logs and later failure or cleanup diagnostics go to stderr, so shutdown never
appends a second JSON document. Build, down, seed, and reset are finite actions
and write their result after the action completes.

Use `--json-stream` when an automation author needs progress from the real
execution lifecycle:

```text
pnpm dev fast up --json-stream
pnpm dev compose up --json-stream
pnpm dev kubernetes validate --json-stream
```

Each stdout line is one JSON object with `format`
`tiara-stack.development.lifecycle`, `eventVersion: 1`, a one-based
`sequence`, the observation `type`, the launcher `command`, `mode`, and
`action`. The event keeps the mode-specific observation fields. Step and
application-start events include a redacted child `process` command. A
`terminal` event is always the last lifecycle line and includes `outcome`,
`exitCode`, final `readiness`, and redacted `diagnostics` when a failure was
reported. Cancellation warnings, such as an incomplete Kubernetes preview,
appear in a separate redacted `warnings` field. The execution outcome set is
`completed`, `stopped`, `blocked`, and `failed`. `completed` is successful finite
work, `stopped` is clean or successfully cancelled long-running work, `blocked`
is a startup or required-step failure, and `failed` identifies cleanup failure
after a stopped or otherwise successful phase. Lifecycle JSONL keeps the stable
failure bucket as `outcome: "blocked"` and adds `executionOutcome: "failed"` for
that cleanup case. The terminal line is written only after cleanup completes or
its bounded failure has been reported.
Startup cancellation therefore still produces a structured terminal line,
including the cleanup result, instead of ending with an empty response.

Compose emits application readiness lines as each selected container becomes
ready. Its terminal line follows attached-command shutdown and application
container cleanup. Child stdout and stderr go to stderr in this mode as well,
so they cannot corrupt the JSON Lines stream.

Cancelling or failing Compose startup stops only the selected application
containers that this invocation started or attached to. It verifies their
container state, escalates from graceful termination when needed, and preserves
background dependencies, volumes, and other Checkout States. Cancellation does
not issue `docker compose down`, delete volumes, or perform a Development
Reset. Use the explicit `compose down` and `compose reset --confirm` actions
when those operations are intended.

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
bounded timeouts before starting the selected host-native process. It reports
`readiness: ready` only after the selected application responds to HTTP GET
`/ready` with a 2xx status, and keeps the process attached to the terminal. An
application startup failure, early exit, or readiness timeout is blocking and
includes remediation. In `--json` mode, the readiness document is emitted
once; later process failure and cleanup diagnostics are sent to stderr.

Finite Kubernetes actions emit one final result after all scheduled steps have
completed or stopped. Child command output is sent to stderr or captured in
`--json` mode so it cannot create an additional JSON document.

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

The process executor remains the replacement seam for tests and bounded local
commands. Planning and execution are separate: help, validation, and plan
inspection never start workloads, while every supported executable mode action
uses the shared lifecycle operation after its validated context is retained.
