# Rollout Gate Control

Use Rollout Gate Control to select one Execution Path for future invocations.
The control applies at caller-and-intent granularity. It can include a client,
Workspace, and Effective Principal. It does not change work that the service
already accepted.

For `services.deliverStatus`, the default is the legacy path. A missing control,
an unavailable control, or an invalid control read also selects the legacy path.
The replacement path is selected only by a matching, durable control record.

## Functional evidence and bulk settlement

Do not treat a time window as proof that a fire-and-forget command worked. A
functional sample follows the accepted invocation through its terminal Workflow
Run outcome and required Delivery Receipt. It also covers a relevant denial or
Declared Failure and one exact-gate rollback followed by a fresh invocation that
selects legacy. An HTTP `202` enqueue response alone is not enough.

For the remaining production rollout, use the smallest representative sample
set that covers each unproven execution or external-effect class. Do not run one
production exercise per contract when existing evidence already covers the same
path. Add samples for missing state mutation, multi-step or recovery,
service-principal or autonomous, and provider or browser behavior as needed.

Before any business sample, run a non-enqueuing preflight across the full
35-contract / 105-route catalog. Verify route registration and request
validation, current Rollout Gate revisions, authorization configuration, legacy
fallback, release health, and monitoring. The preflight must create no Workflow
Run, Delivery Receipt, or external effect.

After the samples pass, promote the remaining controls from an operator-owned
manifest using compare-and-set revisions. Record an audit result for every
control. Roll back a shared failure as a group, an isolated failure by execution
family, and never dual-execute an external effect.

Use an event-based settlement barrier instead of fixed one-hour or three-hour
holds. Advance only when every accepted replacement run is terminal, no run
exceeds its declared Action Deadline, no ambiguous or unresolved delivery or
duplicate effect remains, no System Failure occurred, and the Production Cell
is healthy. Autonomous triggers still require two successful scheduled cycles
unless a safe synthetic cycle is explicitly approved.

After replacement acceptance is complete, verify legacy acceptance is zero and
legacy durable work is drained before entering Legacy Quarantine. Keep legacy
manifests, images, and credentials for the bounded rollback window. Perform
irreversible deletion only through the Deletion Gate.

## Deploy the control

Apply the database migration before enabling a replacement path:

```sh
pnpm --filter sheet-db-schema db:migrate
```

Deploy the `sheet-bot` and `sheet-workflows` changes after the migration. Then
run the trusted OAuth client seed:

```sh
pnpm --filter sheet-auth seed:trusted-oauth-clients
```

The `SHEET_WORKFLOWS` trusted client must have the `service` and
`rollout.gate.write` scopes.
The `SHEET_BOT` trusted client must have the `service`, `token.exchange`,
`workflow.enqueue`, and `rollout.gate.evaluate` scopes.

## Change a control

The change route is:

```text
POST /internal/rollout-gates/change
```

It requires a `sheet-workflows-http` OAuth resource token with the `service` and
`rollout.gate.write` scopes. The request must contain a durable evidence URL and
the expected current revision.

Set these values before the command:

```sh
ROLLOUT_GATE_TOKEN="<short-lived resource token>"
SHEET_WORKFLOWS_URL="http://127.0.0.1:3000"
WORKSPACE_ID="<Discord Workspace ID>"
EFFECTIVE_PRINCIPAL_KEY="*"
```

Use `*` to select all Effective Principals in the selected Workspace. Use
`user:<Effective Principal userId>` for one Effective Principal. Omit
`workspaceId` from the request for a global control.
The matching order is workspace and principal, workspace-wide, global and
principal, then global-wide.

Forward the `sheet-workflows` service locally, or use an approved internal
network path. Then select the replacement path:

```sh
umask 077
ROLLOUT_GATE_CURL_CONFIG="$(mktemp)"
trap 'rm -f "$ROLLOUT_GATE_CURL_CONFIG"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$ROLLOUT_GATE_TOKEN" >"$ROLLOUT_GATE_CURL_CONFIG"

curl --fail-with-body --silent --show-error \
  --config "$ROLLOUT_GATE_CURL_CONFIG" \
  --request POST \
  --header "Content-Type: application/json" \
  --data @- \
  "$SHEET_WORKFLOWS_URL/internal/rollout-gates/change" <<JSON
{
  "contractIdentity": "services.deliverStatus",
  "contractWireVersion": "1",
  "client": { "platform": "discord", "clientId": "discord-main" },
  "workspaceId": "$WORKSPACE_ID",
  "effectivePrincipalKey": "$EFFECTIVE_PRINCIPAL_KEY",
  "executionPath": "replacement",
  "reason": "TIA-148 representative evidence passed and bulk manifest promotion approved",
  "evidenceUrl": "https://linear.app/tiara-stack/issue/TIA-148",
  "expectedRevision": 0
}
JSON
```

The first accepted change returns revision `1`. If another operator changed the
same control, the route returns `409` with `currentRevision`. Repeat the
operation with that value. Do not guess the revision.

## Roll back the Execution Path

Use the same route. Set `executionPath` to `legacy` and use the revision returned
by the previous change:

```json
{
  "contractIdentity": "services.deliverStatus",
  "contractWireVersion": "1",
  "client": { "platform": "discord", "clientId": "discord-main" },
  "workspaceId": "<Discord Workspace ID>",
  "effectivePrincipalKey": "user:<Effective Principal userId>",
  "executionPath": "legacy",
  "reason": "Rollback after a warning or Declared Failure",
  "evidenceUrl": "https://linear.app/tiara-stack/issue/TIA-148",
  "expectedRevision": 1
}
```

This changes future invocations only. It does not cancel or reroute a
replacement Workflow Definition that the service already accepted.

## Verify the selection

Run the status command after the change. Check the `sheet-workflows` logs and
the Rollout Gate evaluation record for the same invocation. Confirm that only
the selected Execution Path has an acceptance record. A replacement enqueue
must not have a legacy dispatch record, and a legacy dispatch must not have a
replacement enqueue record.

Every control change has a Rollout Gate Control Change Audit Record. It stores
`evidence_url`, `changed_by` (the Effective Principal that changed the
control), and `actor_provenance`. Its `effective_principal_key` identifies
the target scope.

Every evaluation returns a Rollout Gate Decision contract record with only
`gateKey`, `revision`, `matched`, `executionPath`, and `reason`.
