# Staged runner source snapshots

`developer-launcher/src/staged-source.ts` defines the local contract for
replacing ordinary or browser runner source from a complete staged snapshot. The snapshot
contains workspace files with explicit `utf8` or `base64` content encoding and
file modes, plus a completion record with an expected file count and SHA-256
digest bound to the revision, paths, encodings, contents, and modes. UTF-8
files store text directly; base64 files preserve arbitrary bytes. Root and
workspace package manifests must use UTF-8 encoding. The producer must seal
the full intended tree before transfer;
validation compares the record before any runtime effects. A truncated transfer
that retains the record is rejected even if root manifests arrived. A new
snapshot sealed after intentionally removing paths represents those deletions.
This local contract detects transfer loss relative to the producer's intact
record; it does not prove that the producer included every source file or
authenticate the record. The absent live adapter must seal from the trusted
workspace before transfer and preserve the record without regenerating it.
Paths are checked before staging, and host
`node_modules`, credentials, secrets, browser caches, absolute paths, and
traversal are rejected. `package.json` and `pnpm-lock.yaml` are required.

The shared runner identity contract names ordinary and browser runner roles;
the API role remains a host lifecycle role rather than a staged Kubernetes
runner identity. This contract does not provision browser dependencies or
establish live browser readiness.

The supervisor stages the full revision, fences its old owner, retains the
previous immutable revision for already accepted work, optionally rebuilds
artifacts, atomically activates the complete revision, restarts the selected
roles, and checks readiness against that revision. Ordinary source changes
restart only selected affected runner roles, including the browser runner when
the workflow uses browser actions. Package manifests, lockfiles, native
artifacts, TypeScript/build configuration, and tool configuration request an
artifact rebuild. `activateCoalescedRunnerSnapshots` selects the newest
complete revision in a save batch. `affectedRunnerRoles` follows `workspace:*`
dependencies to selected workflow consumers. Repeating the already active
revision only rechecks readiness and does not issue a second activation or
restart. The launcher-side `activateRunnerSnapshot` reports requested and prior
active revisions on failure and leaves selected roles unavailable; that
orchestrator does not implement automatic rollback or retries. If staging fails
before pointer promotion, the prior pointer stays in place but the role is
marked unavailable. After pointer promotion, restart or readiness failure keeps
the requested pointer selected and marks that revision unavailable. The
supervisor reports the pointer-selected active revision separately from role
readiness; it never restores or restarts the previous revision automatically.
The prior immutable revision remains on disk for accepted work and an explicit
later activation request. A failed activation cannot be treated as ready just
because the previous revision had been ready before the attempt.

Workflow-affecting activations carry the previous and proposed workflow
definitions, the authoritative old execution group, and explicit user intent.
The previous definition must match old-group artifacts and all existing role
identities. The proposed definition's source revision must match the sealed
snapshot revision, and the runtime must resolve complete API, selected
ordinary/browser runner, contract, deployment, and workflow-version evidence
from that exact snapshot before any settlement or staging. Runner artifacts
are role-specific; selecting both runner roles requires evidence for each. The
developer launcher exposes the explicit
`preview recreate --config <file> --session <id> --confirm-development` path;
automatic incompatible changes present the proposal and pause admission, then
reject.
Explicit changes pause admission, require distinct confirmed fences for
submission connections and autonomous triggers, then settle with immutable
old code and prove cessation before ending the old session. Missing evidence or
unknown producer ownership stops before settlement. Fresh evidence verifies
all proposed workload roles have unique new OAuth clients, carries the exact
cleanup record, and reports zero transferred work. The provider's fresh-group
evidence must echo exactly the proposed required-group set and the fresh session
identity created by the CLI's durable session controller. A durable quarantine
failure returns `QuarantineUnconfirmed` and invokes the independent
ordinary-allocation fence.
The CLI loads a checkout-local configured workflow provider module and composes
it with its session controller. It fails closed without that module, so the
live workflow profile stays disabled in this checkout.

The supervisor writes sidecar metadata for each prepared revision and scans it
under the activation permit. It removes abandoned `.staging-*` trees only while
no activation is in flight. An immutable revision is eligible for pruning only
when it is not selected by the active pointer and an injected runtime settlement
check affirmatively proves no accepted work references it. Missing, false, or
failed evidence retains the revision. The default accounted-storage limit is
1.5 GiB, below the chart's 2 GiB `emptyDir` limit. Before staging, the runtime
must provide an upper-bound estimate that includes dependency materialization;
an unavailable estimate, unrecognized on-disk revision, or capacity overflow
fails closed before staging or pointer mutation with
`staged-storage-capacity-exceeded`. This checkout has no live accepted-work
settlement provider, so it cannot automatically prove old revisions safe to
prune; if retained revisions fill the bound, future activations remain
unavailable until a provider can affirmatively release references.

The runner activation HTTP route rejects a missing authorization header and
authorizes the session before reading the body. It caps snapshot requests at
128 MiB. A stricter inherited `HttpIncomingMessage.MaxBodySize` limit takes
precedence. Declared content length and streamed byte counts are checked before
JSON decoding; an authorized oversized request receives HTTP 413 without
invoking the supervisor. A single permit is acquired after authorization and
bounds concurrent body buffering and schema decoding for 60 seconds. It is
released after decoding or body failure, before supervisor activation. A stalled
body receives HTTP 408. The launcher transport
allows six minutes by default: the server phases are bounded by 60 seconds for
the trusted read-only activation-authority preflight, 60 seconds for body
read/decode, 120 seconds for snapshot preparation, 30 seconds for restart, and
30 seconds for readiness (300 seconds total), leaving one minute of transport
margin. The authority preflight uses TIA-229's approved 60-second read-only
preflight budget and has its own timeout, separate from snapshot preparation.
Callers can still set a shorter explicit transport timeout.

The low-level supervisor requires a trusted activation-authority decision
before staging a new revision, including a first revision when its in-memory
active map is empty. That authority must read durable session state and
immutable prior source, independently resolve the proposed snapshot's complete
artifacts and Action Versions, permit same-identity changes only when
compatible, and permit a first revision only for a newly authorized session.
It must not use caller-supplied mode flags, compatibility declarations, or
version maps as authority. The authority is omitted by default, so source
activation fails closed until configured. Unknown state, missing authority, and
rejected transitions fail before staging. Incompatible recreation proceeds
under its separately provisioned fresh session identity only after the common
launcher lifecycle verifies old-code settlement and cessation and the session
authority can confirm the durable cleanup record. This also closes the restart
case where the supervisor's in-memory active map is empty but durable state is
not new.

The developer launcher's injected staged-runner runtime performs its own
trusted activation authorization before `stageComplete`. Missing, rejected, or
timed-out authorization leaves the revision unstaged. The injected authority
must independently resolve bound durable state; workflow declarations supplied
with the transition are context, not proof of authorization.

Workflow artifact evidence carries the complete action-name to Action Version
map. The map participates in artifact equality and transition classification;
the summary workflow version alone cannot establish compatibility. The
proposed map is checked against artifacts resolved from the exact sealed
snapshot before old-work settlement or source staging.

Recreation output records proposal, admission, producer fencing, settlement,
cessation, provider cleanup, local old-session end, fresh-group provisioning,
and source-activation phases separately. A phase advances only after its
provider operation returns confirmed evidence. A validated cleanup record is
retained if the local controller stop times out; provider cleanup remains
completed while local old-session end stays unconfirmed.
Failures retain `unconfirmed`, `ambiguous`, or `not-started` states as
appropriate. Human and JSON output include the old cleanup record, prior and
requested revisions, transition reasons, fresh session identity, and recovery
disposition; no output infers cancellation, reconciliation, or live cessation
from a later successful phase.

The runtime adapter must implement staging on session-owned writable source
storage while keeping the base image read-only; each activation must be atomic.
It must also provide actual pod/session/revision/group readiness, preserve the
owned workflow state plane and invocation/Action/Delivery identities, and
renew credentials under supervision. Triggers and smoke remain disabled unless
explicitly owned after restart. The launcher contract currently has no live
Kubernetes adapter for these operations, so tests prove only the injected local
contract. They do not claim provider acceptance.

The `ordinary-runner-development` image starts from `node:22-slim` and adds
pinned pnpm, TypeScript, and tsx tools. Production/runtime images continue to
use their package-specific Dockerfiles and contexts. The development image's
root-context build installs the
`sheet-workflows` production workspace dependency closure into a pnpm store for
offline use. The Dockerfile-specific ignore file
`packages/sheet-workflows/Dockerfile.development.dockerignore` allows package
manifests and patches while excluding host `node_modules`, credentials, and
source secrets. The CI matrix uses the root context only for this development
image. The chart has a
`services.sheetWorkflowsRunner.developmentSource.enabled` switch, disabled by
default. When enabled, it selects that image and mounts a pod-owned,
size-limited `emptyDir` at `/workspace`; the pod keeps a read-only root
filesystem. Environment paths identify staged and active directories on that
volume. The values schema requires each path to be a canonical descendant of
`/workspace` and rejects dot or dot-dot segments. The deployment template
requires the roots to be distinct, non-overlapping directories and rejects
equal or nested paths. The runtime adapter that transfers and activates
snapshots is not implemented here. Before running selected source, the adapter
must relink each complete snapshot with
`pnpm install --offline --frozen-lockfile --frozen-store --filter 'sheet-workflows...' --prod --ignore-scripts`,
then run `pnpm rebuild --pending --filter 'sheet-workflows...'` to prepare
approved dependency setup scripts without running scripts from the snapshot's
root package. A supervisor test with a fake process spawner asserts the pnpm
arguments and process configuration; it does not execute pnpm or its lifecycle
hooks. The runtime sets
`pnpm_config_side_effects_cache_readonly=true` so rebuilds may read cached side
effects but cannot write to the read-only store. Snapshot preparation has a
120-second deadline; timeout fails activation, cleans its temporary tree, and
releases the activation permit so a later request can retry.
The runtime image pins pnpm 11.7.0 for `--frozen-store`. It sets
`COREPACK_ENABLE_PROJECT_SPEC=0` and `pnpm_config_pm_on_fail=ignore` so Corepack
and pnpm keep using that image version instead of switching to the snapshot's
`packageManager` pin of 11.1.1. An offline cache miss fails closed because the
store is read-only; rebuild and preload the store before activating a snapshot
that needs missing packages or build outputs. The adapter must then run the
selected source and check actual readiness. The chart switch is a manifest
boundary only and must stay off until that adapter exists. The image provides
tools and dependency packages, but it does not contain links to the staged
source tree.

The same-revision check prevents duplicate activation and restart calls while a
revision is healthy. If that revision is unavailable, recovery revalidates the
durable session and group authority before restarting or checking readiness;
missing, stale, rejected, or timed-out authority leaves the runner unavailable
without those runtime effects. This does not prove duplicate-effect safety for
accepted workflow invocations.

Record group startup target (120 seconds) and edit target (20 seconds)
separately from the 120-second session lease and 30-second supervisor lease.
Those operational leases are not latency targets.
