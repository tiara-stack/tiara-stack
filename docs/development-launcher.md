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
pnpm dev preview heartbeat --session <id> --generation <n>
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
cleanup require `--session`. Heartbeat also requires `--generation` so a stale
supervisor cannot renew a newer session revision. The bare `pnpm dev preview`
command prints help without reading a file or starting a process.

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

### Connected transport and operator setup

Connected transport is unsupported until the operator has prepared the
workspace with the pinned Telepresence client, matching cluster manager and
traffic-agent versions, a working TUN device, effective NET_ADMIN/network
capabilities, development DNS, authenticated cluster access, and actual scoped
attachment authorization. `preview doctor` reports each check independently.
Connected execution remains unavailable until those host, DNS, cluster, and
authorization checks pass.

The operator provisions a dedicated Service and relay workload per session and
selected host role in the development-only `preview-relays` namespace. A relay
has one approved application port, session/role identity, and one reserved
host listener. The configured client owns a Lease for each workspace-host and
loopback-port pair in `preview-relays`; a Lease held by another session on the
same host causes a collision. The
Lease is removed when an attachment is detached or setup rolls back. If a host
process exits without session cleanup, the Lease remains fail-closed and an
operator must reconcile that exact owned Lease before reusing the port. The
Telepresence attachment may target only that relay. It must
be denied for shared application workloads; do not grant routine workspaces
deployment patch, secret read, pod exec, or cluster-admin permissions. Keep
the pinned manager's necessary discovery permissions explicit, including
cluster-scoped ServiceCIDR discovery if that version requires it.

The operator installs the resources in
[`deploy/kubernetes/preview-relays/`](../deploy/kubernetes/preview-relays/):
the namespace, dedicated controller and workspace ServiceAccounts, a controller
Role for exact Service/Deployment/NetworkPolicy get-create-delete calls and
Lease get-list-create-delete recovery,
and a separate workspace Role limited to read-only pod and Service discovery.
Do not add broad workspace `pods/portforward` permissions. The doctor only
reports scoped attachment ready when an injected adapter verifies the exact
session/role/process target and denies the shared-workload control; without
that adapter, the check is unavailable and the profile stays unavailable.
The namespace also has default-deny ingress/egress NetworkPolicies. Review
these with the pinned
Telepresence version and cluster's CNI before operator application. The
configured provider verifies the installed default-deny and DNS-egress
egress policies before creating per-session resources; it does not create or
broaden the shared operator RBAC. Add the per-session policy produced
by the relay provider for that session's exact labels, approved development
caller selectors, and approved destination selectors. Omitted peers and
destinations stay denied. Do not add shared-application or production
selectors. The sample namespace and policies are examples only and have not
been applied or live-validated.

The launcher provider API is injectable through `PreviewRelayProvider`. Set
`TIARA_PREVIEW_RELAY_CONFIG` to the path of a JSON file containing the validated
development API endpoint, contexts, pinned Telepresence version, pinned relay
image digest, development allowlists, and token environment-variable name. It
must also provide the traffic-manager namespace and a non-empty exact manager
pod label selector. Its API port defaults to TCP `8081` for the pinned
Telepresence v2.18.2 manager and can be overridden for an operator-specific
deployment. The generated per-session NetworkPolicy permits TCP only to pods
matching both that namespace and selector on that port; it never opens the
whole manager namespace. Invalid hostnames, empty/malformed selectors, and
production-marked destinations leave the provider unavailable. Bind only
short-lived, namespace-scoped credentials to the dedicated ServiceAccounts;
the controller Role cannot list/watch or create/delete pods. The CLI selects
the live adapter only when the config and token are present; module startup
makes no cluster requests. `preview doctor` performs bounded, read-only cluster
and Telepresence checks. `preview start` performs the first resource writes and
attachment. It uses the Kubernetes HTTPS API and the pinned
`telepresence intercept` / `leave` commands. It verifies
session/role/process/owner
labels and listener receipts before recording provider resource IDs in the
existing allocation ledger. Without valid configuration the CLI fails closed;
the filesystem allocation adapter cannot satisfy a connected profile. The
HTTPS dependency probe uses the configured FQDN for both the
request URL and TLS server name, resolves only the exact development allowlist,
and maps DNS, network, TLS, and application-authentication failures
separately. The CLI resolves `env://NAME` credential references and fails
closed on unresolved references; other secret schemes require an injected
resolver. Secret values are never included in output.

NetworkPolicy and managed-service firewalls must admit only the gateway,
session relay/agent, and explicitly approved development caller sources on
required ports. Egress is limited to approved development Service FQDNs,
DNS, and explicitly configured development database/cache destinations.
Production and unrelated private destinations remain denied. Preserve each
managed service's configured FQDN, TLS verification, and development
credentials; diagnose route/network reachability, DNS, TLS, and application
authentication as separate failures.

Relay records and attachments are owned by exact session and role identifiers.
Startup adds separate `preview-relay-service-<role>` and
`preview-relay-attachment-<role>` entries to the session's durable allocation
ledger for every selected host runtime role, so cleanup uses recorded ownership.
Before attachment, after detach, on identity mismatch, or when the target
process is gone, the endpoint returns unavailable and has no shared upstream.
Port collisions and wrong targets block startup. Cleanup removes only the
session's recorded relay and attachment; it preserves the manager/agent
infrastructure, shared services, and other sessions. The local relay harness
proves this contract with two sessions and an unchanged shared control; it is
not evidence of live Telepresence or cluster acceptance. Do not advertise a
connected profile until operator setup and the live acceptance checks are
recorded.

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
  "hostListeners": [
    {
      "role": "sheet-auth",
      "host": "127.0.0.1",
      "port": 8443,
      "processId": "sheet-auth"
    }
  ],
  "environmentFileInputs": [{ "role": "sheet-auth", "path": "environment/sheet-auth.env" }],
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

### Workflow producer ownership boundary

The workflow runtime also exposes a producer-only API role for composition
and acceptance work:

```text
SHEET_WORKFLOWS_ROLE=producer
```

This role serves the existing workflow enqueue and observation HTTP routes
through the remote workflow client. Its runtime policy forces autonomous
trigger names to an empty list, disables smoke enqueue, assigns no shard
groups, and does not compose the cluster runner, workflow dispatcher, run
reconciliation loop, or scheduled task layers. Its `/ready` check only probes
the API storage connection and does not require local runner registration or
shard locks. `WORKFLOWS_AUTONOMOUS_TRIGGER_NAMES`
selects `autoCheckin` and/or `autoRoleCleanup` for scheduled enqueue on `api`
and `combined` roles and workflow registration on `runner` and `combined`
(defaulting to both to preserve current behavior).
`WORKFLOWS_SMOKE_WORKFLOW_ENABLED` remains the explicit smoke enqueue control
and defaults to false. Producer mode ignores both controls to keep its policy
restricted.

`WORKFLOWS_TRIGGER_TARGET_OWNER` is an optional identity slot carried by the
runtime policy for a future fenced owner. This prefactor does not validate or
claim that identity, allocate an external target, or enable a live preview.
The connected preview implementation remains unavailable until its separate
admission, ownership, and lifecycle gates are implemented and verified. This
role does not establish that enqueueing against shared execution is safe.

Credential fields contain development secret references only. The launcher does
not resolve or print referenced secret values. Additional user grants default to
none. Triggers and external targets default to none. `seed` is optional and is
accepted only with an owned `application-zero` group. Selecting `sheet-bot`
requires an explicit target allocation and acknowledgment that the shared bot
will be unavailable during handoff. These fields record intent; plan does not
perform those operations.

`pnpm dev preview plan --config <file>` returns `readiness: planned` when the
configuration passes static validation. It lists unit-bearing quota dimensions
but does not reserve them. `pnpm dev preview doctor --config <file>` checks
selected profile demand against provider measurements in the authority
database. Missing observations, wrong provider identity, unverified grants,
stale data, and exhaustion block readiness. Exhaustion includes requested,
reserved, and available values.

Import an operator-collected baseline by setting
`TIARA_PREVIEW_CAPACITY_BASELINE_FILE` to a JSON file, then run:

```sh
pnpm dev preview baseline --config .dev/preview.json
```

The file contains `measurements` and `profiles`. Measurements record provider,
exact identity, dimension, observation time, total, in-use amount, and grant
verification. A profile record names the profile, selected roles, owned
groups, demand amount for every required dimension, and one resource per owned
group. The importer validates the complete profile and stores observations and
demand plans transactionally. It makes no provider calls and never invents
capacity. Provider-specific collection remains the operator's responsibility
until that provider adapter is configured.

Measurements are fresh for 900000 ms (15 minutes) by default, based on their
original `observedAt` value; importing a baseline does not refresh its age.
Set `TIARA_PREVIEW_MAX_MEASUREMENT_AGE_MS` to a positive safe integer in
milliseconds to override the default. An absent or blank value uses the finite
default. Any other invalid value prevents the allocation controller from
initializing and keeps session start unavailable. Doctor retains and reports
stale observations; reservation and allocation reject them.

Set `TIARA_PREVIEW_SESSION_DATABASE` to a private local SQLite path before
using session actions. `start` validates profile demand, checks fresh exact
provider observations and grants, reserves every dimension, records ownership,
then calls the configured infrastructure adapter. Missing evidence fails
before allocation. `status` reads session and allocation ledgers without
renewing; `heartbeat` requires the current generation; `resume` requires the
local owner identity and fences the previous generation; `stop` closes normal
admission idempotently. `cleanup` refuses live sessions, waits for settlement
and adapter proof, waits five minutes after proof, and releases reservations
only after exact owned resources are confirmed deleted. Connected application
runtime profiles remain unavailable and are never launched by these commands.
If an allocation has no recorded provider resource ID, `resolve` invokes an
explicit owner-authorized adapter lookup for that one ledger row. The adapter
must return fresh evidence tied to the recorded session, resource, owner token,
and one of the session's reserved provider identities, and confirm that the
provider allocation operation has settled. A momentary "not found" result while
allocation may still be in flight cannot resolve the row. A verified resource is
added to the exact ownership ledger; verified absence is recorded durably.
Cleanup then repeats its proof delay and deletion flow. Retry or operator
assertion alone cannot resolve an ambiguous row or release its reservation.
Plan and session responses keep launcher JSON `schemaVersion: 3` and lifecycle
JSON Lines `eventVersion: 1`.

The launcher uses its Effect `PreviewSessionController` service backed by
SQLite as the local controller protocol boundary. It durably records the
owner, checkout, selected manifest digests, requested and active revisions,
phase, generation, renewal time, and terminal state. A session identity is
generated at creation; the authority database stores only the digests. The CLI
never prints either identity. It stores the owner credential and rotating
supervisor credential in an owner-only sidecar alongside the configured
database. Resume rotates the
supervisor credential and generation; the owner credential cannot renew a
lease. The lease lasts 120
seconds from the last successful heartbeat, with a 15-second renewal interval.
Every authority check compares the deadline directly, so delayed sweeps cannot
extend admission. Resume requires the same identity, claims an expiring
supervisor lease, and increments the generation; stale-generation writes are
rejected. Stop is idempotent and terminal. Status does not renew the lease.

The allocation controller stores provider-identified capacity measurements,
reservations, and per-resource ownership records in the authority store. It
validates complete profile demand plans against the per-group dimension
catalog, checks exact provider identity and fresh grant-verified observations,
and reserves all dimensions before adapter allocation. Partial allocations,
unknown ownership, and deletion failures retain their reservations for
inspection. Cleanup derives ended and settled state from the durable session
row, asks the adapter for proof, waits five minutes from that proof, and
releases reservations only after the ledger is empty.
Deletion uses a durable conditional claim per resource. A concurrent cleanup
waits while a deletion claim is active; a claim left stale by a controller
restart is retried after the adapter timeout. Resource adapters must make
deletion idempotent for the exact recorded provider resource ID and owner token.
Provider adapter planning, validation, allocation, proof, deletion, and ownership
resolution calls have a 60000 ms default timeout. A timed-out allocation is
quarantined as ambiguous and keeps its reservation until the provider confirms
the allocation operation has settled and ownership is resolved; proof timeout leaves
cleanup waiting, deletion timeout quarantines and holds capacity, and resolution
timeout leaves the unknown row quarantined. The controller constructor accepts
a positive safe-integer timeout override.

The CLI imports provider evidence collected by an operator; it does not
configure provider clients or fetch capacity itself. This checkout supplies a
local filesystem adapter for disposable owner-marker resources, but does not
configure live PostgreSQL, Zero Cache, Redis, Kubernetes, Meilisearch, OAuth,
Discord, or Google Sheets adapters. Profiles needing those providers remain
unavailable until their provider identity, grants, measurements, demand plan,
and cleanup proof are supplied by an adapter. The CLI's filesystem adapter
refuses connected-profile allocation even when a capacity baseline exists; the
filesystem adapter is used only by the local disposable acceptance path.

The CLI creates a missing database parent directory with mode 0700. It rejects
an existing parent directory that is owned by another user or is writable by
the group or world. The CLI sets a restrictive umask and the identity sidecar
directory and files use mode 0700 and 0600. Back up the durable
database and credential sidecars together; keep both outside the checkout.
The embedded controller is single-host and single-writer. Runtime workloads
must not mount its database or credential directory. The `PreviewSessionRuntime`
service exposes only admission and one-work settlement; it has no create,
heartbeat, resume, or stop methods. A future remote
deployment must provide authenticated TLS and map its service identities to
the narrow admission and settlement interface; no remote or production
controller is configured by this launcher.

### Workload credential issuer contract

The launcher exports a typed `PreviewWorkloadCredentialIssuer` and two adapter
paths. `PreviewWorkloadCredentialIssuerLive` requests host tokens through
`KubernetesTokenRequestClientLive` and stores each token in a managed file with
mode 0600 under a mode 0700 session directory. Kubernetes roles get an
explicit projected service-account token volume with the selected audience,
service account, mount path, and 600-second request. The configured
`KubernetesWorkloadIdentityProvisionerConfigured` creates or reuses the exact
owner-labeled service account and deterministic Sheet Auth OAuth client,
applies a projected-volume descriptor through a role workload applier, and
removes the exact owned resources after settlement. It uses an explicit
Kubernetes controller token and separate OAuth administration headers. The
role workload applier and its operator credentials are not configured in this
checkout.

Each request binds a credential name from the existing positive role
allowlist, session, generation, role, service account, and audience. The
controller records the OAuth client ID and file for that identity. Renewal
runs halfway between the grant's recorded `issuedAt` and actual `expiresAt`.
The issuer rejects mismatched bindings, grants longer than ten minutes, and
renewals that change the OAuth client or owned file. Cleanup checks that the
session ended and all accepted work settled, then removes only the exact
recorded file, service account, and client.

The host adapter must use a restricted TokenRequest file owned by the selected
session and role. The Kubernetes adapter must use a projected token with an
explicit audience and the exact role service account. Neither adapter may
borrow a pod token, import a whole environment, or read ambient production
credentials. The host TokenRequest HTTP client and private-file adapter are
implemented. The service-account and OAuth-client provider adapters are
configurable; the role workload applier and operator authority still need
configuration. All connected runtime profiles remain unavailable until those
provider operations are configured and verified.

Operators must configure controller administration credentials separately
from the auth service's TokenReview reviewer credential. The controller needs
only the provider permissions to create, renew, and delete the exact preview
service accounts, OAuth clients, TokenRequest files, and projected-token
workloads it owns. The auth reviewer needs TokenReview permission only. Its
audience must match the projected token request, and its exact service-account
allowlist must contain only the intended bot actor for delegated subject
minting. Keep delegated subject prefixes narrow. Do not grant issuer signing,
TokenReview, or controller administration credentials to workload roles.

Before enabling a profile, an operator must supply and verify both adapters,
their exact ownership policy, audience and role mappings, reviewer credentials,
and the development-only service-account and OAuth-client permissions. Local
protocol tests do not prove those live grants. Cleanup may remove only the
service accounts, clients, and files recorded as session-owned, after their
work settlement purpose ends. Shared logins and external credentials remain
outside cleanup authority.

Token exchange accepts a `preview_session` binding only when the injected
`PreviewSessionAuthority` authorizes that session, generation, role, and actor
client. It places the binding in the exchanged access token. Resource
authorization checks the same authority on every request, including cache hits
for a cryptographically valid JWT, and denies the request after stop, expiry,
generation fencing, or identity mismatch. `makePreviewSessionAuthority` adapts
the local durable controller to that interface. For separate services,
`PreviewSessionControllerHttpsLive` serves the narrow controller routes with a
configured certificate and private key. The auth service's
`SHEET_AUTH_PREVIEW_SESSION_CONTROLLER_URL` must use HTTPS and the separate
`SHEET_AUTH_PREVIEW_SESSION_AUTHORITY_TOKEN`. Set
`SHEET_AUTH_REQUIRE_PREVIEW_SESSION_FOR_TOKEN_EXCHANGE=true` for an auth
instance dedicated to preview traffic. The controller server keeps authority,
credential administration, and workload admission credentials separate. It
does not expose create, stop, resume, or general controller operations over
HTTP. The authority is absent by default, so preview exchanges fail closed.

The HTTP workload API derives session, generation, role, and OAuth client from
the configured workload authenticator. Each admission records its group,
invocation, continuation, endpoint, and target under an opaque admission ID.
Settlement presents the exact recorded tuple and uses the admission ID as its
bearer credential; it does not re-authenticate the workload. Treat that ID as a
one-time secret. Stop and expiry block new admissions while allowing those
recorded admissions to settle.

## Mode matrix

| Mode       | Runtime processes                                                                                                          | Allowed origins                                                                            | State boundary                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------- |
| Fast       | `sheet-web` by default; explicitly selected `sheet-auth`, `sheet-db-server`, `sheet-workflows`, or `sheet-bot` on the host | web uses development HTTPS endpoints; backend slices use host-reachable local dependencies | shared Fast development sandbox       |
| Compose    | packaged runtime containers and local dependencies                                                                         | loopback URLs only                                                                         | the selected local Checkout State     |
| Kubernetes | fixed development preview release                                                                                          | `*.dev.theerapakg.moe` endpoints                                                           | shared Kubernetes Development Sandbox |

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

Owned application/Zero allocation, migration ordering and exact cleanup are
documented in [Owned application and Zero State Planes](owned-application-state-planes.md).
The operator adapter has local contract tests; no live application/Zero profile
is enabled by those tests.

## Public session probe gateway

The probe-only route and owner-grant protocol, HTTPS/WSS transport boundary,
operator prerequisites, cleanup and evidence limitations are documented in
[Session preview gateway](preview-gateway.md). Application routes and live public
profiles remain unavailable until their adapters and acceptance gates pass.
