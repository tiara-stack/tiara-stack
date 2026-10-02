# Development workflow acceptance

This is the supported path for choosing and validating a TiaraStack development
environment. It keeps the edit loop local, makes the state boundary visible,
and reserves external integrations for explicit development-only checks.

## Choose a mode

| Mode or plan           | Use it for                                      | Process boundary                                                                                      | Dependencies and state                                                                                                                |
| ---------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Fast                   | Web edits against stable service contracts      | The host-native `sheet-web` watch process by default. Backend slices require an explicit `--service`. | Development HTTPS endpoints for the web slice, or host-reachable local dependencies for a selected backend. No Compose state.         |
| Compose                | Contract-crossing changes and local integration | Packaged containers for the selected Checkout State                                                   | Local Postgres, Redis, JWKS, Zero Cache, OTEL sink, and runtime containers. State is scoped by the checkout path.                     |
| Kubernetes             | Cluster behavior and preview promotion          | The fixed `tiara-stack-dev` release in the `tiara-stack-dev` namespace                                | The shared Kubernetes Development Sandbox and its centrally managed Development Credential Set.                                       |
| Connected Preview plan | Review role and admission requirements          | Reads versioned JSON plus explicit role environment files. Starts no process and creates no session.  | Reports group, capacity, and external ownership requirements. No resources are reserved or allocated; live checks remain unavailable. |

The supported process boundary is the deployable runtime. Shared libraries are
dependencies, not selectable processes. Fast mode uses ports 3001 through 3005
for the runtime slices, 4848 for Zero Cache, and 9464 for Prometheus. Compose
uses the same application ports plus 5432 for Postgres and 6379 for Redis.
An occupied deterministic port blocks startup. The launcher does not choose a
random replacement.

## First run

Start with read-only checks:

```sh
pnpm install
pnpm dev doctor --json
```

Then choose one path:

```sh
# Fast
pnpm dev fast up

# Compose
pnpm compose:generate-secrets
pnpm dev setup compose
pnpm dev compose build
pnpm dev compose up

# Kubernetes validation, with no deployment
pnpm dev kubernetes validate

# Connected Preview plan and prerequisite report, both read-only
pnpm dev preview plan --config .dev/preview.json
pnpm dev preview doctor --config .dev/preview.json

# Lifecycle events for automation
pnpm dev compose up --json-stream
```

Fast reads `.env.development.local`. Compose reads
`deploy/compose/.env`. Kubernetes uses `KUBE_CONTEXT=tiara-stack-dev` and the
fixed development namespace and release. The bare `pnpm dev` command and a mode
without an action print help only.

A valid Connected Preview plan reports `readiness: planned`, lists the unit
bearing capacity dimensions for each required owned group, and remains an
estimate. `preview doctor` checks the selected profile demand against persisted
provider observations and reports missing identity, missing grants, stale
measurements, and requested/reserved/available exhaustion values. Any such
finding blocks readiness. `preview baseline` imports operator-collected
provider observations and profile demand plans from the JSON file named by
`TIARA_PREVIEW_CAPACITY_BASELINE_FILE`. The importer validates identities,
dimension coverage, amounts, and profile selection before its durable write.
It makes no provider calls. Provider-specific collection still requires a
separately configured adapter and operator credentials; this worktree does not
configure them.

Capacity evidence defaults to a maximum age of 900000 ms (15 minutes),
measured from the observation's original `observedAt` timestamp, not import
time. Set `TIARA_PREVIEW_MAX_MEASUREMENT_AGE_MS` to a positive safe integer to
change it. An absent or blank value uses the finite default; any other invalid
value prevents the allocation controller from initializing, so start remains
blocked. Stale imported evidence is retained so doctor can diagnose it, but
cannot be reserved or allocated.

`preview start` asks the configured demand planner for the selected roles and
owned groups, checks the exact provider observations and grants, reserves all
dimensions atomically, writes the ownership ledger, and then calls the
infrastructure adapter. Missing evidence, exhaustion, or adapter failure
blocks before application admission. Status reports the durable reservation
and allocation ledger. Cleanup reads ended/settled state from the session
database, asks the adapter for cleanup proof, waits five minutes from that
proof, deletes only exact recorded resources, and releases reservations only
when the ledger is empty. Failed or ambiguous deletion stays quarantined for
safe retry and controller restart recovery. A durable conditional deletion claim
serializes concurrent cleanup calls; adapters must make deletion of the exact
recorded resource ID and owner token idempotent. The launcher keeps every connected
application runtime profile unavailable; this path does not start app
processes.

Provider adapter calls have a 60000 ms default timeout. A timeout during
allocation, proof, deletion, or unknown-owner resolution fails closed: uncertain
resources remain quarantined and their reservations stay held.

Unknown-owner resolution requires fresh provider evidence that the allocation
operation itself has settled; a momentary absent lookup cannot release capacity
while an allocation may still complete.

Local acceptance injects an opt-in profile planner over the real filesystem
adapter and exercises public start/status/cleanup with a disposable owner
marker file, including another session's resource isolation. The CLI's default
filesystem adapter refuses connected-profile allocation. Database,
search-index, Redis, OAuth, Discord, Sheets, and Kubernetes workload adapters
are not configured here. No shared or production infrastructure was contacted.

## Boundaries

Fast web mode passes only `APP_BASE_URL`, `AUTH_BASE_URL`,
`SHEET_ZERO_BASE_URL`, and `SHEET_WORKFLOWS_BASE_URL`. It rejects production
origins, Compose-only DNS names, backend credentials, service tokens, Google
credentials, and Discord credentials. Host-native backend services use only
the local dependencies and credentials owned by the selected service.

Compose's environment file is a local Development Credential Set. The secret
generator preserves existing passwords and writes ignored files. The existing
commands remain supported during rollout:

```sh
pnpm compose:generate-secrets
pnpm compose:migrate-sheet-db
```

`pnpm dev compose up` starts infrastructure, runs forward-only migrations, and
starts application services only after those steps succeed. `down` preserves
the selected Checkout State. `reset --confirm` removes only that checkout's
local volumes. It does not rotate credentials or touch Discord accounts, OAuth
registrations, Google Sheets, or service-account resources. There are no
automatic down migrations, `db:push` calls, or local-to-remote fallbacks.

Kubernetes validation runs strict Helm lint and development-value rendering.
Preview requires both an image tag and `--confirm-development`, targets only
`tiara-stack-dev`, waits for workload readiness, and reports every parity gate.
Required gates fail the preview. Unchanged gates are reported as
`not-affected`, not silently skipped.

## Evidence and changed surfaces

For a change that crosses a runtime, contract, schema, persistence, packaging,
or external-integration boundary, run the relevant local evidence before
preview promotion:

```sh
pnpm dev compose up
pnpm dev kubernetes preview --tag <image-tag> \
  --confirm-development \
  --changed-surface <surface>
```

The supported changed surfaces and their overlays are documented by
`docs/development-launcher.md`. HTTP, authentication, and Workflow API changes
require API and ordinary-runner smoke. Workflow storage or runner changes also
require the terminal workflow contract smoke. Browser-runner changes require
the controlled Chromium smoke. Helm, ingress, network-policy, secret-wiring,
and persistence changes require Kubernetes invariants.

Discord and Google Sheets checks are opt-in only. They identify their dedicated
Development Credential Set and their external resources. Discord evidence may
post and delete a marked message in the development channel. Google Sheets
evidence reads the bounded `A1:C3` range. Neither check runs in the default CI
gate.

CI runs the local launcher plan checks and the shared Fast execution lifecycle.
That lifecycle starts a real local `sheet-web` watch process, verifies its
existing HTTP GET `/ready` response, records the time at the launcher's
Development Readiness observation, and cleans up the process tree. The Fast
external prerequisites use bounded local CI adapters, so the evidence path
does not contact development services or use their credentials. A startup
message alone does not pass this check. The result is the
`development-evidence` JSON artifact. Timings are reported without a p95 or
p99 threshold, so the artifact remains evidence rather than a new performance
gate.

Fast, Compose, and Kubernetes executable actions share the same lifecycle
contract: mode-specific dependency or promotion checks must pass before
readiness, finite work reaches a terminal result only after its steps finish,
and cancellation reports cleanup or incomplete shared work explicitly. The
default evidence path exercises only the real local Fast application seam; it
does not start external integrations or mutate shared Compose/Kubernetes
resources.

Connected Preview plans are configuration evidence only. They do not prove
endpoint reachability, deployed compatibility, grants, capacity, readiness, or
cleanup ownership. An unavailable doctor check stays unavailable until its
read-only probe records evidence.

## Failure remediation

`pnpm dev doctor --json` is the first diagnostic. Fix the named dependency,
port, origin, credential, or state path in its remediation field, then rerun
the same command.

- Missing Fast endpoints or an occupied port means the host slice cannot start.
- Missing Compose secrets means rerun the generator and fill only the local
  credential placeholders.
- A Compose artifact error means run `pnpm dev compose build`; `up` never builds
  implicitly.
- A migration failure blocks application startup. Inspect the selected
  Checkout State and rerun the migration after fixing the local database.
- A Kubernetes context, credential, Helm, or rollout error blocks promotion.
  Confirm the development context, inspect the named parity gate, and retry
  after repairing the development cluster.

The complete journey is accepted when the selected mode's doctor checks pass,
the mode-specific command reports readiness, the applicable evidence gates are
green, and no production deployment, credential, or state was changed.
