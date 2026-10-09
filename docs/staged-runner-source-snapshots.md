# Staged ordinary runner source snapshots

`developer-launcher/src/staged-source.ts` defines the local contract for
replacing ordinary runner source from a complete staged snapshot. The snapshot
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

The supervisor stages the full revision, fences its old owner, retains the
previous immutable revision for already accepted work, optionally rebuilds
artifacts, atomically activates the complete revision, restarts the selected
roles, and checks readiness against that revision. Ordinary source changes
restart only the ordinary runner. Package manifests, lockfiles, native
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
body read/decode, 120 seconds for preparation, 30 seconds for restart, and
30 seconds for readiness (240 seconds total), leaving two minutes of transport
margin. Callers can still set a shorter explicit transport timeout.

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

The same-revision check prevents duplicate activation and restart calls. It does
not prove duplicate-effect safety for accepted workflow invocations.

Record group startup target (120 seconds) and edit target (20 seconds)
separately from the 120-second session lease and 30-second supervisor lease.
Those operational leases are not latency targets.
