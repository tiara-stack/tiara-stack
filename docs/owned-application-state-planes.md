# Owned application and Zero State Planes

TIA-242 adds the operator-side `application-zero` allocation adapter to the
existing launcher allocation ledger. No live profile is enabled by this change.
The implementation is tested with an in-memory controller, Effect HTTP session
endpoints, and a recording SQL connection. These tests do not establish live
PostgreSQL grants, replication, Zero mutation deduplication, or cleanup acceptance.

## Admission and ownership

`makeOwnedApplicationResourceAdapter` accepts one explicitly configured profile
containing `sheet-db-server`, `sheet-web`, and the owned `application-zero` group.
Other owned groups require their own adapters. Shared groups retain their
existing admission path. There is no independent-cache/shared-upstream option.

The existing allocator reserves measured capacity before invoking this adapter.
The application group now includes database and role counts, in addition to
slots, temporary slots, senders, connections, WAL, sync/resync, cache CPU, memory,
and storage. Three scoped roles are required. This adapter uses a single
operator provider identity for its measured group demand; it does not infer
measurements across different infrastructure providers.

The session manifest must contain `application-zero`, the canonical SHA-256
`applicationPlaneDigest` of `ApplicationArtifacts`, and `deployed-manifest`,
matching the deployment digest in those artifacts. The artifacts include
ordered migration IDs, names and byte digests, generated schema, callback,
authorization and client digests, and Zero version 1.5.0. The provider must read
fresh development-only evidence bound to the entire plane digest, verify the
required effective grants and credential confinement, and inspect server-wide
name availability. Missing evidence blocks provisioning.

A centrally assigned session ID and allocation owner token derive a fixed-length
app ID. The durable `preview_application_names` table reserves database, three
roles/grants, app, current and legacy schemas/publications/triggers/slots, dynamic
slot prefixes, replica files and volumes, credential files, session destinations,
and client storage identity. PostgreSQL object names fit its 63-byte limit.
Names are reserved across the server, except the migration-owned `zero_data`
publication, which is scoped to the separate database. Reservations are committed
before provider effects and retained during quarantine.

## Provisioning and startup

Relays are allocated before the application group, so callback readiness can use
an existing session destination. The application allocation then performs:

1. Fresh compatibility, identity, grant and reservation checks.
2. Provisioning of an empty database and distinct migration/runtime/replication
   roles. Password verifiers and connection credentials stay in the operator's
   managed credential store, outside the ledger and launcher output.
3. Generated artifact validation/application and ordered forward migrations by
   one migration owner, before starting application processes.
4. Matching Zero Cache, host db-server and client configuration, followed by
   readiness through the session endpoints. Every returned state/artifact
   identity must match the recorded plane.

`makeOwnedApplicationPostgres` supplies standard PostgreSQL provisioning, ACL,
fencing and exact deletion primitives. Its allocator grant check requires
logical WAL and an effective operator superuser. It does not grant superuser to
runtime roles. Managed-provider variants with different privileges remain
unavailable until separately verified. The operator must also prove connection
confinement: PostgreSQL's REPLICATION attribute alone is not a database-scoped
credential boundary.

Each scoped role and its ownership comment are created in one transaction. The
database is created and marked in separate statements because PostgreSQL does
not allow `CREATE DATABASE` inside a transaction block. If database marking
fails after creation, the unmarked database is not safe for automatic ownership
cleanup and requires operator recovery.

`initializeOwnedApplication` checks immutable artifact bytes before DDL, verifies
`current_database()` and the migration role, and serializes bootstrap with a
transaction advisory lock. It records digests in a private app bootstrap schema
and maintains `sheet_db_effect_sql_migrations` for the existing runtime admission
policy. Existing digest history must match exactly; an unjournaled nonempty
application database is rejected. Migration failure prevents startup. This is an
initial bootstrap job, not a live schema-transition or watcher migration hook.

Provider composition must use the repository's launcher process/relay lifecycle
boundary. It must apply public-table grants after migration, initialize the
cache's owned Zero schemas, apply `grantZeroRuntime`, then admit callbacks and
matching clients. `applicationRuntimeConfiguration` sets db-server to
`shared-admission` after bootstrap. It names one database for upstream/CVR/change
stores, explicit `/zero/query` and `/zero/mutate` session destinations, a separate
replica path, and a session/state-specific client storage key. It carries role
references rather than connection secrets. Runtime startup always disables its
legacy seed switch; TIA-244's named synthetic seed runs once in the owned
provisioning phase after migrations and before application startup.

Empty state remains the default. The only accepted selector is
`synthetic-development-v1`, and configuration validation requires an owned
`application-zero` group. The allocator's trusted binding resolver must verify
the real development User Principal, its linked Discord Account, and an
approved development guild/channel. The fixture creates only inert application
rows for that account and target: DM preferences are disabled, the guild
workspace and channel conversation are stopped, and no sheet, schedule,
permission, role, session, credential, workflow item, or Response Reference is
created. It does not invoke Discord, Google, or other external APIs. Trusted
OAuth client provisioning remains an independent operation.

The provider applies the rows and a seed identity receipt in one transaction.
It returns the same receipt for an interrupted retry of that exact seed without
inserting again, and rejects a conflicting receipt or nonempty unjournaled
database. The launcher stores pending/completed seed identity in its owned-plane
journal and includes `seed=<id>;status=complete` in the allocated provider
reference. Migration, binding, fixture, or journal failures quarantine
provisioning before application startup. Resume and reload do not allocate or
seed again; a fresh owned state receives a new fixture only when explicitly
selected.

## Cleanup and recovery

The common controller ends admission and waits for accepted work and its existing
five-minute proof interval. Cleanup claims the recorded plane, fences queued
provider operations and writers, and verifies inventory before deleting anything.
An inventory mismatch, active backend, unresolved allocation, or uncertain
termination quarantines the group. Capacity and name reservations stay held.

Deletion orders exact slots, triggers, publications, schemas, files, volumes,
grants, databases, then roles. Provider operations recheck exact ownership at
deletion and must be idempotent. The PostgreSQL primitives use exact slot names
and database predicates, never SQL `LIKE` or stock `zero-out`. Backend termination
rechecks PID, database and one of the three recorded roles. A foreign backend is
not terminated. Dropping the verified owned database removes its contained grants,
schemas, publications and triggers even if no slot ever existed. Roles are dropped
without `DROP OWNED` or `REASSIGN OWNED`; dependencies outside the group block
release. Files/volumes and stored credentials require their provider's exact
owner checks and removal proof.

For a failed allocation without a returned provider ID, stop the session and use
the existing owner-authorized `resolveUnknownAllocation` operation. The adapter
loads its durable plane record, fences the provider, and requires terminal
operations, terminated writers and exact inventory. This also recovers a hard
process crash that left the plane in `provisioning`, `migrating` or `starting`:
the session must be ended, and the provider must prove that no operation from
the old process can still complete before resolution restores the fenced plane
for normal cleanup. An ended allocation with no plane journal is proved absent:
reservation checks and the journal transaction precede all provider effects.

An interrupted deletion whose journal is still `deleting` is intentionally not
reclaimed on elapsed time alone. Operator recovery must establish that the old
operation is terminal before repairing that claim. Do not clear reservations,
retry blind SQL, or redirect the session to shared state. Final release requires
an empty inventory with terminal-operation and writer-termination proof.

An interrupted unknown-allocation resolution whose plane journal remains
`resolving` is also not reclaimed automatically. Operator recovery must establish
that the provider fence and inventory proof are terminal before restoring a
claimable phase; capacity and name reservations remain held.

## Evidence and remaining live gates

The focused tests cover two owned groups, empty initial rows, separate callback
query/mutation destinations, an unchanged shared control, stopped-session
rejection, failed migration, partial allocation without slots, stale/incompatible
admission, foreign or active resources, and retained reservations. Seed tests
check deterministic rows through the owned application endpoint,
principal/account and approved target bindings, authorization-preserving
rejection of a different principal, ordering after migration, no external calls,
completion output, and no second seed on reallocation. SQL tests check exact
predicates and ownership failures. Bootstrap tests check byte-digest
rejection before SQL, single execution, ordering, rollback requests, and rejection
of foreign owners, old digests and nonempty state.

The recording SQL tests do not run a PostgreSQL server or prove transaction,
privilege, backend termination, WAL, or slot behavior. The HTTP tests exercise the
common controller with synthetic endpoints, not the Zero protocol or a browser.
No database, live credential, Kubernetes workload, or external service was
provisioned during implementation.

Before any live profile can be advertised, an operator must supply a disposable
PostgreSQL/Zero environment, confined credentials, measured quotas, verified
artifact loader and compatibility evidence, managed credential/replica storage,
and process/relay adapters. That environment must verify scoped-role behavior,
DDL detection, actual migration artifacts, cache startup, callback identity,
query/mutation deduplication, client matching, stop/crash/expiry, partial failures,
absent/active slots, exact cleanup and unchanged shared/other-session controls.
The CLI retains its unsupported-profile gates until those prerequisites and live
acceptance are supplied. Merely constructing this adapter is not live admission.
