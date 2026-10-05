# State Plane runtime policies

State Plane startup has two separate responsibilities: admitting an existing
database and initializing a database that this process explicitly owns.

## db-server

`DB_BOOTSTRAP_POLICY` selects db-server behavior:

| Value                          | Behavior                                                                                                                                                                                                                             | Owner                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `deployment-migrate` (default) | Runs the existing Effect SQL migration path before opening Zero's database client.                                                                                                                                                   | Established deployment bootstrap.                                                               |
| `shared-admission`             | Reads the existing `sheet_db_effect_sql_migrations` journal and requires an exact ordered match for every known migration ID and name. It does not create the journal, run DDL, or open the application client after a failed check. | Runtime admission only; migrations remain the operator deployment's responsibility.             |
| `owned-initialize`             | Requires `DB_MIGRATION_OWNER` and runs the existing forward migration path for an explicitly allocated database.                                                                                                                     | The allocator's single migration owner. Other processes using this database must use admission. |

The default retains Fast, Compose, and Kubernetes startup behavior. Preview
profiles should select `shared-admission` for reused state. Provisioning must
select `owned-initialize` for exactly one process before starting its db-server
and consumers; ordinary reloads must not select it. The policy is an explicit
ownership assertion and does not provision credentials or grant database
privileges. The Effect SQL migrator serializes migration execution; the
allocator remains responsible for selecting one migration-owner process.

## Workflow runtimes

`WORKFLOWS_STATE_PLANE_POLICY` defaults to `deployment-default`, preserving
current startup. `shared-admission` and `owned-admission` run the same read-only
migration-journal check before the runtime exposes its PostgreSQL client to
workflow stores, cluster storage, consumers, or routes. Owned-state migrations
still belong to the separately selected db-server provisioning owner; workflow
processes never migrate the database.

Admission currently verifies the exact ordered migration IDs and registered
artifact names in the database journal. Missing journals, partial histories,
unknown entries, and renamed entries fail closed. The journal schema records
IDs and names but does not record source-content checksums; a later migration
metadata change is required before content-digest admission can be claimed.
Admission is not a live deployment compatibility manifest and does not verify
Zero callback, authorization, workflow payload, Redis, or search-index
contracts. Preview profiles remain unavailable until those independent
contracts are checked by their runtime catalog.

## Migration ownership

Shared application/auth/workflow schemas are migrated by the coordinated
operator deployment process. Preview startup only admits them. Preview-owned
databases are migrated forward by one provisioning owner before applications
become ready. A migration failure blocks that dependency group; do not retry
from another runtime or fall back to shared state. Reloads reuse the selected
database and do not start migrations.

The owned application allocator and its separate digest journal are documented
in [Owned application and Zero State Planes](owned-application-state-planes.md).
They add an initial single-owner bootstrap path without changing the existing
shared-admission journal or enabling an unverified live profile.
