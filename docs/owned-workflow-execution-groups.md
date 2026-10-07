# Owned workflow execution groups

TIA-246 defines the contract for one preview-owned Workflow API and its ordinary
Kubernetes runner. Both use the same preview database and matching
application, command, run, and cluster stores. The host API's enqueue and
observation endpoints are explicit group endpoints. A runner is admitted only
when its registered pod UID/address, session, owner, generation, role, stores,
artifact identities, required capability, and 600 owned ordinary shard locks
match the group's recorded identity.

The launcher contract tests exercise two preview groups and an unchanged shared
control. A healthy runner from the shared control or another preview cannot
satisfy a group's readiness. Compatible API process or runner pod replacement
retains the original database, stores, endpoints, and generation, preserving
the durable invocation, Action Key, and Delivery Key records. A compatible
replacement may change the API or runner artifact digest, but must retain the
contract digest, deployment digest, workflow version, database, stores, and
both endpoints. Changes to those compatibility or durable identity fields fail
admission.

`verifyWorkflowRunnerEvidence` checks consistency of a provider-supplied
observation; it does not discover Kubernetes pods or query health endpoints or
shard locks itself. A runtime adapter must source the pod UID/address,
group-scoped health, artifacts, capabilities, and owned shard evidence from the
actual providers before using the predicate. No such provider is implemented
in this slice.

Only explicitly selected controlled smoke work is admitted by this contract.
Autonomous Triggers remain off and the smoke path cannot request external
effects. Enqueue and observation must name the same group. Cleanup is eligible
only after provider operations are terminal, API admission is fenced, current
and stale runners have stopped, reclaimed command leases have been reconciled,
lost host dependencies have been accounted for, active external calls have
terminated, accepted work has settled, and ownership is known. Missing any of
these facts leaves the group quarantined.

This is contract evidence, not a provisioner or live runtime integration. The
owned workflow execution profile remains disabled. In particular, no workload
adapter currently creates the API/runner resources, scopes live database and
Kubernetes credentials, registers actual pods, or proves cessation. General
owned-work exposure and live smoke acceptance stay unavailable until that
adapter and live two-group isolation evidence are complete. No production or
external development service was contacted for these tests.
