# Sheet bot Delivery Key reconciliation

Use this Recovery Command only when a `sheet-bot` Delivery Key remains unresolved after a provider failure or process interruption. It never calls Discord. It inspects or atomically changes the reservation so an ordinary caller can safely replay the original operation.

## Alert and diagnostics

Both reconciliation alerts ship disabled by default and cannot fire until `monitoring.deliveryReconciliationAlerts.enabled` is set to `true`. Reconcile the legacy pending and ambiguous backlog created by the reservation-index backfill before enabling them. `SheetBotDeliveryReconciliationRequired` fires after the oldest unresolved reservation exceeds `monitoring.deliveryReconciliationAlerts.unresolvedAgeSeconds` (900 seconds/15 minutes by default) for the configured `monitoring.deliveryReconciliationAlerts.for` duration (5 minutes by default). `SheetBotDeliveryObservabilitySaturated` fires after the same configured `for` duration when a storage page exceeds the implementation inspection limit (currently 1,000 unresolved markers). Overflow is carried across refreshes. The startup cycle publishes partial values until it completes; subsequent cycles retain the last complete snapshot so an alert's pending duration is not reset by a partial scan. After a complete scan cycle, a resolved reservation is expected to disappear within two 30-second refreshes while `sheet_bot_delivery_observability_saturated == 0`. When saturation is nonzero, wait for it to return to zero after a complete scan cycle before applying that freshness guarantee. If it remains nonzero, treat the oldest-age snapshot as potentially stale and use the saturation alert and structured logs to reduce the unresolved backlog first.

The relevant metrics are:

- `sheet_bot_delivery_unresolved_reservations`
- `sheet_bot_delivery_oldest_unresolved_age_seconds`
- `sheet_bot_delivery_observability_saturated`
- `sheet_bot_delivery_ambiguous_outcomes_total{operation=...}`
- `sheet_bot_delivery_reconciliations_total{resolution=...,result=...}`

Redis may return a marker more than once during a cursor scan, so `sheet_bot_delivery_unresolved_reservations` is an approximate upper bound. Use `sheet_bot_delivery_oldest_unresolved_age_seconds` as the authoritative alert signal and inspect individual Delivery Keys before reconciliation.

Ambiguous outcomes and every Recovery Command also emit structured logs with the Delivery Key, operation, hashed actor, hashed evidence, and resolution. Message content, provider credentials, the raw operator identity, evidence text, and the original input are never logged. The durable reconciliation record retains the raw operator identity and evidence for audit attribution and returns them only through this operator command.

## Inspect first

Run the command inside the live `sheet-bot` pod so it uses that deployment's Redis namespace and encryption configuration:

```sh
SHEET_BOT_NAMESPACE="<sheet-bot-namespace>"
kubectl --namespace "$SHEET_BOT_NAMESPACE" exec deploy/sheet-bot -- \
  node dist/reconcile-delivery.mjs \
  inspect --delivery-key "$DELIVERY_KEY"
```

The `outcome` is one of:

- `confirmed`: the original Delivery Receipt is durable and a replay returns it without a Discord write.
- `safeRetry`: an operator recorded evidence that the provider effect did not commit. The next matching caller may make one attempt.
- `unresolved`: the provider result is still unknown. Replays remain blocked.
- `notFound`: no retained reservation exists for this Delivery Key. Stop and verify the client ID and key before doing anything else.

## Record the provider finding

Every mutation requires the operator identity and a durable evidence reference, such as an incident URL, audit-log query, or provider message link.

When Discord proves that the write committed, construct the operation-specific `DeliveryReceipt` from the observed resource and record it:

```sh
SHEET_BOT_NAMESPACE="<sheet-bot-namespace>"
kubectl --namespace "$SHEET_BOT_NAMESPACE" exec deploy/sheet-bot -- \
  node dist/reconcile-delivery.mjs \
  confirmed \
  --delivery-key "$DELIVERY_KEY" \
  --actor "$OPERATOR" \
  --evidence "$EVIDENCE_URL" \
  --receipt-json "$DELIVERY_RECEIPT_JSON"
```

The receipt's Delivery Key and operation must exactly match the reservation. A subsequent caller receives that receipt and does not repeat Discord.

When Discord proves that the effect did not commit, mark exactly this reservation safe for one retry:

```sh
SHEET_BOT_NAMESPACE="<sheet-bot-namespace>"
kubectl --namespace "$SHEET_BOT_NAMESPACE" exec deploy/sheet-bot -- \
  node dist/reconcile-delivery.mjs \
  safe-retry \
  --delivery-key "$DELIVERY_KEY" \
  --actor "$OPERATOR" \
  --evidence "$EVIDENCE_URL"
```

An `ambiguous` reservation can be marked immediately after the provider check because its original call has returned. A timestamped `pending` reservation may represent an interrupted or still-running provider call, so the command refuses safe retry until it is at least 15 minutes old. A legacy `pending` reservation created before timestamps were introduced has no enforceable age; release it only after proving that every pre-upgrade bot pod has terminated. In every pending case, prove that the original pod or request cannot still be active.

If the evidence remains inconclusive, explicitly retain the reservation:

```sh
SHEET_BOT_NAMESPACE="<sheet-bot-namespace>"
kubectl --namespace "$SHEET_BOT_NAMESPACE" exec deploy/sheet-bot -- \
  node dist/reconcile-delivery.mjs \
  unresolved \
  --delivery-key "$DELIVERY_KEY" \
  --actor "$OPERATOR" \
  --evidence "$EVIDENCE_URL"
```

Never choose `safe-retry` merely because the original caller saw an error. A timeout, connection reset, pod interruption, or lost response is an Ambiguous Outcome and may have committed at Discord.

## Validate recovery

Inspect the same Delivery Key again. After a complete scan cycle and while `sheet_bot_delivery_observability_saturated == 0`, verify that the resolved reservation disappears and the alert clears within two 30-second metric refresh intervals. When saturation is nonzero, the published gauges may still describe the last complete cycle and the two-refresh guarantee does not apply. Wait for the saturation metric to return to zero after a complete scan cycle. If it remains nonzero, inspect the saturation alert and structured reconciliation logs and reduce the unresolved backlog before taking another action.
