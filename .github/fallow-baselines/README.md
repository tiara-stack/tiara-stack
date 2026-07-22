# Fallow baselines

These baselines replace source-level, file-wide Fallow suppressions. Each entry is an exact
diagnostic or clone-group fingerprint, so moving or materially changing the affected code makes
Fallow ask for an explicit baseline review.

Owner: `@theerapakg`

## Accepted debt

- `dupes.json`: immutable SQL migration snapshots, intentionally explicit API/command/test setup,
  and remaining cross-package clones that do not yet have a stable shared ownership boundary.
  Shared middleware, auth-client construction, and command registration are excluded from this
  rationale because they use shared factories.
- `dead-code.json`: seven narrow exceptions remain. The four dependency findings are configuration
  imports that Fallow's source scan does not see (`sheet-db-schema` in three Vite configs and
  `start-atom` in the sheet-web router). `ProviderAiReviewClient.runStructured` implements its
  public client interface. The `Any` and `make` duplicate exports are intentionally namespaced
  Zero API constructors/types (`ZeroApi`, `ZeroApiGroup`, `ZeroApiEndpoint`, and `ZeroApiClient`).
- `health.json`: existing complexity findings whose control flow is domain-specific and should be
  reduced in focused follow-up changes rather than hidden at file scope.

Do not add `fallow-ignore-file`. Prefer removing the finding. If an exception is unavoidable,
update the narrow baseline and this justification in the same review.
