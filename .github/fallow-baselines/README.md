# Fallow baselines

These baselines replace source-level, file-wide Fallow suppressions. Each entry is an exact
diagnostic or clone-group fingerprint, so moving or materially changing the affected code makes
Fallow ask for an explicit baseline review.

Owner: `@theerapakg`

## Accepted debt

- `dupes.json`: immutable SQL migration snapshots, intentionally explicit API/command/test setup,
  service Zero-client lifecycle code, deterministic workflow-key implementations, and remaining
  cross-package clones that do not yet have a stable shared ownership boundary. The generated Zero
  schema in `packages/sheet-zero-api/src/schema.ts` contains parallel table shapes and is regenerated
  from `sheet-db-schema`, so its exact clone group is baselined rather than edited by hand.
  Middleware and auth-client production logic use shared factories where available; mirrored
  contract tests and thin package-local service declarations remain baselined. Command registration
  uses shared factories and is not accepted as duplicate debt.
- `dead-code.json`: narrow exceptions remain. Four of the six dependency findings are configuration
  imports that Fallow's source scan does not see (`sheet-db-schema` in three Vite configs and
  `start-atom` in the sheet-web router). `sheet-workflow-contracts` is a runtime schema dependency
  used by `sheet-formulas`, but Fallow 2.88.2 does not trace those schema imports from the Apps
  Script entrypoint. `sheet-domain` is imported by the calculation-range implementation, but that
  internal workflow entrypoint is not traced from the package root. `ProviderAiReviewClient.runStructured`
  implements its public client interface. The `Any` and `make` duplicate exports are intentionally
  namespaced Zero API constructors/types (`ZeroApi`, `ZeroApiGroup`, `ZeroApiEndpoint`, and
  `ZeroApiClient`). The `text` duplicate is a test-only text factory kept local to the workflow test
  helpers.
- `health.json`: existing complexity findings whose control flow is domain-specific and should be
  reduced in focused follow-up changes rather than hidden at file scope. The team-submission test
  harness gained one nullable configuration-binding fallback while adapting to the required row
  contract; its existing moderate CRAP finding is tracked until that harness is split.

Do not add `fallow-ignore-file`. Prefer removing the finding. If an exception is unavoidable,
update the narrow baseline and this justification in the same review.
