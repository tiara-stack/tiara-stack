# TiaraStack Improvement Report

Presentation revised: 2026-07-22  
Verification snapshot: 2026-07-22

## TL;DR

1. **The improvement ledger is fully accounted for.** Of 38 in-scope findings, **28 are resolved by PRs, 1 is no longer applicable, and 9 remain**.
2. **The replacement Graphite stack landed intact.** PRs [#590](https://github.com/tiara-stack/tiara-stack/pull/590) through [#596](https://github.com/tiara-stack/tiara-stack/pull/596) are merged, their queue-trigger `to merge` labels are absent, and the verified stack-tip commit is `73f2ce886b279601ea1a5a85568da58d0c70287e`.
3. **PRs #606 and #607 close three related design/type-safety findings.** Sheet configuration now has one cache owner, and the database model now has a canonical Effect SQL representation with generated Drizzle/Zero projections, parity tests, regeneration-diff enforcement, and an assertion ceiling.
4. **PRs #608–#612 close seven boundary and design findings.** OAuth validation, sheet-config rejection, ingress exports, Zero dispatch, Discord builder types, and guild-cache failure behavior now have explicit runtime/type contracts and regression coverage.
5. **PR #620 replaces hidden structural debt with owned, measurable debt.** All 73 source-level Fallow pragmas are removed, exact reviewed baselines are documented centrally, and repeated authorization, client, command, workflow, status, timeline, SQL-test, and schema machinery is shared.
6. **The remaining work is concentrated in operational resilience and focused maintenance.** Unbounded fan-out outside the repaired guild-cache path remains alongside weak telemetry coverage, single-replica defaults, ingress-only NetworkPolicies, missing tests, stale documentation, and the empty `bob` placeholder.

## Scope and stack disposition

This report was verified through the GitHub API against the replacement Graphite stack. Superseded PR [#589](https://github.com/tiara-stack/tiara-stack/pull/589) is closed without merge. The classification below is unchanged from the verified report; this revision aligns its hierarchy, tone, and presentation with the earlier TiaraStack improvement ledgers.

| PR | Branch | Final head SHA | State | Final PR-head `workspace_ci` |
| --- | --- | --- | --- | --- |
| [#590](https://github.com/tiara-stack/tiara-stack/pull/590) | `theerapakg/ci-vite-version-alignment` | `813492557c04936748fcad7291ea01e69a46f515` | Merged | Successful |
| [#591](https://github.com/tiara-stack/tiara-stack/pull/591) | `theerapakg/ci-helm-render-fallbacks` | `dd796561959bcca6b971ed222f9a21f9440c9907` | Merged | Successful |
| [#592](https://github.com/tiara-stack/tiara-stack/pull/592) | `theerapakg/workspace-cli-resolution` | `2ddff869d68e366dc22a93a8f4742ea2c55c4fc3` | Merged | Successful |
| [#593](https://github.com/tiara-stack/tiara-stack/pull/593) | `theerapakg/root-effect-dev-dependency` | `7f695c666d0c65dcb62bac0fb6e436d2a2ef27e5` | Merged | Successful |
| [#594](https://github.com/tiara-stack/tiara-stack/pull/594) | `theerapakg/shared-typescript-project-references` | `b5209ae31ad6efc6030766a2fb79572d6a94fc5f` | Merged | Failed at the final PR head; higher stack heads passed |
| [#595](https://github.com/tiara-stack/tiara-stack/pull/595) | `theerapakg/shared-vite-config` | `08a730dc33244ba4c4e83ef5bbbb8a2b234ae13f` | Merged | Successful |
| [#596](https://github.com/tiara-stack/tiara-stack/pull/596) | `theerapakg/fallow-baseline-regression` | `d69238fb309c0910a42a4f9a1e4f43bc763b549d` | Merged | Successful |
| [#606](https://github.com/tiara-stack/tiara-stack/pull/606) | `theerapakg/sheet-config-cache-dedup` | `7a713010feca6d08a90795ea21ef9bdf39309b9b` | Merged | Successful |
| [#607](https://github.com/tiara-stack/tiara-stack/pull/607) | `theerapakg/sql-zero-drizzle-canonical-model` | `dabb4cdf5f7ad05d0a5e0ebb10e81eb3c65ca787` | Merged | Successful |
| [#608](https://github.com/tiara-stack/tiara-stack/pull/608) | `theerapakg/web-oauth-timeouts-validation` | `18610456669f5aff11c9bec8e6bb3005fb555f5d` | Merged | Successful |
| [#609](https://github.com/tiara-stack/tiara-stack/pull/609) | `theerapakg/sheet-config-parsing-validation` | `33629cfda856ef5f45dff80181928f05a6349441` | Merged | Successful |
| [#610](https://github.com/tiara-stack/tiara-stack/pull/610) | `theerapakg/ingress-api-public-surface` | `fd634e65c0d48a0af4875ea241f17200e0cd77bc` | Merged | Successful |
| [#611](https://github.com/tiara-stack/tiara-stack/pull/611) | `theerapakg/zero-dispatch-typed-registry` | `db4146da7e1631523d4a173cd19a9edb99b5c1cf` | Merged | Successful |
| [#612](https://github.com/tiara-stack/tiara-stack/pull/612) | `theerapakg/discord-builder-type-safety` | `43ec1565ff71d9424c97099bbfbddfe504ba8e93` | Merged | Successful |
| [#620](https://github.com/tiara-stack/tiara-stack/pull/620) | `theerapakg/fallow-suppression-cleanup` | `5f03f8b0979cb01882d23f71212acaa73621dbb5` | Merged | Successful |

**Stack status.** PRs #590–#596 are merged and their queue-trigger `to merge` labels are absent. PR #594's final head records a failed `workspace_ci`, but Graphite merged it and the higher #595/#596 stack heads passed, so its fixes remain present and verified in the merged stack. The post-stack verification tip is `73f2ce886b279601ea1a5a85568da58d0c70287e` (`ci(fallow): restrict baseline job permissions`).

**Current review disposition.** At the label decision, PR #606 head `4c7caed43434884a5a2978b8601e952c8688cbe6` and PR #607 head `1432d84063d5ad7167855e1d2a7e0ab511cce3c5` were open, `mergeable: true`, `mergeable_state: clean`, fully green (with the production deployment check skipped), and had no requested-changes reviews. The `to merge` label was applied to both on 2026-07-19. Graphite rebased and merged #606 as `7a713010feca6d08a90795ea21ef9bdf39309b9b` at 10:03:27Z and #607 as `dabb4cdf5f7ad05d0a5e0ebb10e81eb3c65ca787` at 10:05:26Z; the trigger labels were then removed automatically.

**PR #608–#612 disposition.** Immediately before labeling on 2026-07-20, every PR was open, ready-for-review, `mergeable: true`, `mergeable_state: clean`, fully green, unlabeled, and had no requested-changes reviews. Each directly resolved at least one finding, so `to merge` was applied to all five. All five are now merged at the rebased heads shown above.

**PR #620 disposition.** Immediately before labeling on 2026-07-22, head `ca94726ad52655c77c0b9f21d6a9e3219f8d06b4` was open, ready-for-review, `mergeable: true`, `mergeable_state: clean`, fully green, unlabeled, and had no requested-changes reviews. The diff closes the Fallow-suppression finding below, so `to merge` was applied. Graphite rebased and merged it as `5f03f8b0979cb01882d23f71212acaa73621dbb5`; the trigger label was removed automatically.

## Resolved problems

### Earlier remediations — PRs #577–#585

1. **Persistence model typing was discarded at the public schema boundary** — Resolved by [PR #577](https://github.com/tiara-stack/tiara-stack/pull/577). Concrete Drizzle/Effect/Zero types now survive the public boundary, with assertions isolated in tested adapters.

    **Original finding text.** **Persistence model typing is discarded at the public schema boundary.** `packages/sheet-db-schema/src/schema.ts:34-50` casts fourteen generated tables through `unknown as PgTable`, losing their concrete column types. The Effect SQL lowering layer also forces Drizzle APIs through `unknown`/`never` (`packages/effect-sql-kit/src/drizzle-lower.ts:214-248,325-359`), while `packages/effect-zero/src/schema.ts:16-34` returns a normalized record `as never`. This makes schema-generator drift hard to detect and pushes errors toward runtime/migrations. Suggested direction: preserve generic table types end-to-end, add compile-time type tests for generated exports, and keep one narrowly documented compatibility adapter per upstream limitation.
2. **The ingress router erased contract types at its security-sensitive boundary** — Resolved by [PR #578](https://github.com/tiara-stack/tiara-stack/pull/578). Contract-derived handler tables now enforce endpoint coverage and request/error types.

    **Original finding text.** **The ingress router erases contract types at its most security-sensitive boundary.** `packages/sheet-ingress-server/src/index.ts:215-235` casts a layer through `unknown`, indexes clients as `Record<string, SheetApisEndpointClient>`, and converts a missing typed endpoint into `Effect.die`. The workflow forwarding path repeats `as never` at `:249`, `:362`, and `:383`. A contract/client mismatch therefore evades compile-time checking and becomes a defect rather than a typed service error. Suggested direction: derive a typed handler table from the HttpApi contract and require it to `satisfies` the complete endpoint map; isolate any unavoidable library adapter cast in one tested helper.
3. **The shared API contract package reached into persistence** — Resolved by [PR #579](https://github.com/tiara-stack/tiara-stack/pull/579). Persistence dependencies were removed in favor of narrow contract/domain models.

    **Original finding text.** **Medium — The shared API contract package reaches into persistence.** `packages/sheet-ingress-api/package.json` depends on `effect-sql-schema` and `sheet-db-schema` in addition to the intended contract utilities. That couples HTTP/workflow contracts to the database implementation and increases rebuild/cycle pressure. Move persistence-derived model adaptation behind a dedicated model/schema package, or invert it so the DB layer implements contract-owned schemas.
4. **The OAuth plugin combined too many trust boundaries** — Resolved by [PR #580](https://github.com/tiara-stack/tiara-stack/pull/580). Verification, clients, policy, token exchange, and endpoints were split into focused modules.

    **Original finding text.** **Medium — The OAuth plugin has too many trust boundaries in one file.** `packages/sheet-auth/src/plugins/sheet-oauth/index.ts` implements user linking, access-token identity, trusted clients, Kubernetes TokenReview, subject minting, token exchange, and endpoints. Separate verifier/client components from endpoint policy and use Effect HTTP/Schema adapters so timeout, telemetry, retry, redaction, and error mapping are consistent.
5. **Workflow dispatch was a god service** — Resolved by [PR #581](https://github.com/tiara-stack/tiara-stack/pull/581). Dispatch operations and activity-boundary policy were split by domain.

    **Original finding text.** **High — Workflow dispatch is a god service.** `packages/sheet-workflows/src/services/dispatch.ts` combines Sheet API facades, Discord rendering, feature flags, message delivery, dozens of operations, and cleanup; `dispatchRegistry.ts` adds authorization, entity routing, persistence retry, and failure notification. Split stable per-domain workflow modules (check-in, room order, team submission, guild lifecycle) behind a small registry. Keep persistence retry policy at the cluster/activity boundary rather than inside each operation wrapper.
6. **Domain/composition files were beyond reviewable units** — Resolved by [PR #581](https://github.com/tiara-stack/tiara-stack/pull/581). The large workflow files became small facades/composition roots with focused modules.

    **Original finding text.** **High — Domain/composition files are far beyond reviewable units.** Fallow identifies `DispatchService.make` in `packages/sheet-workflows/src/services/dispatch.ts:1109` as 3,711 lines. Entire files are 4,825 lines (`dispatch.ts`), 1,778 (`sheet-ingress-server/src/index.ts`), 1,635 (`sheet-db-schema/src/zero/api.ts`), 1,546 (`vibecord/src/sdk/index.ts`), 1,367 (`sheet-apis/src/services/teamSubmission.ts`), 1,315 (`dispatchRegistry.ts`), and 1,215 (`sheet-auth/src/plugins/sheet-oauth/index.ts`). Suggested direction: split by operation/domain and keep composition roots declarative; separate pure render/parse logic, authorization policy, external clients, persistence, and orchestration.
7. **Dynamic proxy assembly duplicated the API type system** — Resolved by [PR #582](https://github.com/tiara-stack/tiara-stack/pull/582). Typed proxy, authorization, handler, and runtime layers are now separated.

    **Original finding text.** **High — Dynamic proxy assembly duplicates the API type system.** `sheet-ingress-server/src/index.ts:130-213` reconstructs HttpApi group/endpoint request/error types, then bypasses them in `forwardSheetApis` and workflow dispatch (`:215-383`). Unknown targets die, and authorization is interleaved with transport payload augmentation. Generate a complete proxy handler map from the contract and compose authorization policies as typed endpoint metadata/interceptors.
8. **Package export conditions were inconsistent** — Resolved by [PR #585](https://github.com/tiara-stack/tiara-stack/pull/585). The affected packages now pair built runtime files with built declarations.

    **Original finding text.** **High — Package export conditions are inconsistent.** `packages/sheet-bot/package.json:6-9` exports raw `./src/*.ts` even though `build` produces `dist`; `effect-sql-schema/package.json:12-22` and `sheet-db-schema/package.json:11-31` expose source files in the `types` condition while runtime defaults use `dist`. Other packages consistently expose `dist/*.d.mts`. This makes consumer behavior depend on resolver conditions and can pull private source/compiler settings across package boundaries. Standardize a single export template and validate it with `publint`/pack-consumer tests.
9. **`sheet-web` retained a backend implementation dependency** — Resolved by [PR #585](https://github.com/tiara-stack/tiara-stack/pull/585). Runtime code uses ingress contracts; the remaining `sheet-apis` link is type-only.

    **Original finding text.** **Medium — `sheet-web` retains a backend implementation dependency.** `packages/sheet-web/package.json:40-48` depends on `sheet-apis`; its tsconfig maps `sheet-apis` directly to `../sheet-apis/src` (`packages/sheet-web/tsconfig.json:8-14`). Even if runtime requests go through ingress, frontend typechecking is coupled to backend source. Move all shared request/response types into `sheet-ingress-api` and remove the implementation dependency.

### Replacement Graphite stack — PRs #590–#596

10. **Vite+ version drift** — Resolved by [PR #590](https://github.com/tiara-stack/tiara-stack/pull/590). Both CI `setup-vp` installs now use `0.2.4`, matching the workspace catalog.

    **Original finding text.** **Vite+ version drift:** CI installs Vite+ `0.2.3` in both jobs (`.github/workflows/ci.yml:38-43,181-186`), but the workspace catalog pins `@tiara-stack/vite-plus@0.2.4` (`pnpm-workspace.yaml:28`). Align setup and local versions so CI exercises the published Effect integration actually selected by the lockfile.
11. **Production Helm rendering could be skipped in PR CI** — Resolved by [PR #591](https://github.com/tiara-stack/tiara-stack/pull/591). Missing repository variables receive deterministic fallbacks, supplied values are preserved, strict validation runs, and `helm template` always executes.

    **Original finding text.** **Production Helm rendering may be skipped in PR CI.** The render step uses `validate_deploy_vars optional` and exits successfully when repository variables are absent (`.github/workflows/ci.yml:88-103`). Supply deterministic dummy values in CI so `helm template` always runs; retain the existing strict `helm lint` and schema validation.
12. **Fallow could not resolve generated CLI entry points outside package roots** — Resolved by [PR #592](https://github.com/tiara-stack/tiara-stack/pull/592). `effect-zero` and `effect-sql-kit` expose workspace binaries, and `sheet-db-schema` invokes them through `pnpm exec` without sibling `dist` traversal.

    **Original finding text.** **Fallow cannot resolve generated CLI entry points outside package roots.** Full analysis warns that `sheet-db-schema` scripts point to `../effect-sql-kit/dist/cli/index.mjs` and `../effect-zero/dist/cli/index.mjs` (`packages/sheet-db-schema/package.json:40-43`). Prefer workspace binaries/package exports rather than sibling `dist` traversal; this also removes implicit build-order coupling.
13. **Fallow misclassified the root `effect` install model** — Resolved by [PR #593](https://github.com/tiara-stack/tiara-stack/pull/593). Root `effect` is explicitly a tooling/deploy-script dev dependency, matching the private workspace root's install model.

    **Original finding text.** **Fallow reports root `effect` as a dev dependency used in production.** `package.json:16-22` puts `effect` in devDependencies, while root production scripts import it; full `fallow dead-code` reports this at `package.json:18`. Either classify deploy scripts as tooling in Fallow or move the runtime dependency—do not simply ignore the warning without documenting the install model.
14. **Strict indexing and optional-property checks were absent workspace-wide** — Resolved by [PR #594](https://github.com/tiara-stack/tiara-stack/pull/594). `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are enabled centrally, and surfaced diagnostics were fixed.

    **Original finding text.** **Strict indexing/optional-property checks are absent workspace-wide.** All 22 package tsconfigs enable `strict`, but none enables `noUncheckedIndexedAccess` or `exactOptionalPropertyTypes`; examples include `packages/sheet-apis/tsconfig.json:3-33`, `packages/vibecord/tsconfig.json:3-25`, and `packages/sheet-web/tsconfig.json:33-39`. This matters in code that destructures split strings, indexes endpoint maps, and consumes rows. Adopt both flags through a shared base config in phases, starting with contract/core packages; use explicit guards instead of broad assertions.
15. **There was no shared TypeScript baseline or enforced project-reference boundary** — Resolved by [PR #594](https://github.com/tiara-stack/tiara-stack/pull/594). Shared Node/browser/Apps Script configs, composite references, `.ts-out`, and `tsgo -b` now enforce package boundaries.

    **Original finding text.** **No shared TypeScript baseline:** package tsconfigs repeat nearly identical compiler options and path aliases, while the root `tsconfig.json:1-73` only lists references. Introduce a base config (and narrower browser/node/apps-script variants), enable `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes` centrally, and let package configs contain only deltas. Root references currently do not translate into package-to-package project references, so path aliases compile dependency source directly rather than enforcing built package boundaries.
16. **Vite/lint configuration drifted package by package** — Resolved by [PR #595](https://github.com/tiara-stack/tiara-stack/pull/595). All package configs consume shared library/app/browser/Apps Script factories defining lint, declaration, environment, and bundling policy once.

    **Original finding text.** **Vite/lint config drift:** every non-`bob` package owns a `vite.config.ts`; only a subset explicitly configures the same `unicorn`, `typescript`, and `oxc` plugin/rule block, while application packages add one-off variants. Extract shared library/application config factories so type-aware linting, ignores, declaration generation, environment, and bundling policy change together.
17. **Fallow's changed-line PR gate could not prevent growth of existing debt** — Resolved by [PR #596](https://github.com/tiara-stack/tiara-stack/pull/596). The fast PR audit remains, while full dead-code, duplication, and health baselines now run as regression gates and are uploaded as artifacts.

    **Original finding text.** **Fallow's PR gate cannot reveal existing debt.** `.github/workflows/ci.yml:191-201` audits only added lines, and `npx fallow audit` on the current master correctly analyzed zero changed files. A full `npx fallow --summary --no-cache` found one dependency issue, 4.8% duplication, and 80 functions above the configured complexity threshold. Keep the changed-code gate, but add a saved full-repo baseline/regression job so debt cannot grow. Review the broad `ignoreDependencies` and `ignoreExports` entries in `.fallowrc.json:21-66` rather than adding more suppressions.

### PR #606 — Sheet configuration cache ownership

18. **Sheet configuration was wrapped and cached twice** — Resolved by [PR #606](https://github.com/tiara-stack/tiara-stack/pull/606), reviewed at `4c7caed43434884a5a2978b8601e952c8688cbe6` and merged as `7a713010feca6d08a90795ea21ef9bdf39309b9b`. `packages/sheet-apis/src/services/sheet.ts:976` now obtains `SheetConfigService` and delegates its five configuration operations directly instead of creating a second set of configuration caches. `packages/sheet-apis/src/services/sheetConfig.ts:430-434` remains the single cache owner, while `packages/sheet-apis/src/http.ts:49-52` wires Google Sheets, configuration, and sheet services at the composition root. `packages/sheet-apis/src/services/sheet.test.ts` adds an identity regression test for the delegation boundary.

    **Original finding text.** **Medium — Sheet configuration is wrapped and cached twice.** `SheetService` delegates five configuration methods to `SheetConfigService` (`packages/sheet-apis/src/services/sheet.ts:972-993`) and then wraps them in another set of `ScopedCache`s (`:1098-1132`), while `SheetConfigService` already creates caches at `sheetConfig.ts:408-429`. Clarify which service owns fetch/parse/cache invalidation and expose one cache layer. Wire infrastructure at the application composition root rather than repeatedly embedding concrete `.layer` providers in domain services.

### PR #607 — Canonical database model and assertion guard

19. **Generated Zero schema output was assertion-heavy** — Resolved by [PR #607](https://github.com/tiara-stack/tiara-stack/pull/607), reviewed at `1432d84063d5ad7167855e1d2a7e0ab511cce3c5` and merged as `dabb4cdf5f7ad05d0a5e0ebb10e81eb3c65ca787`. The generated `packages/sheet-db-schema/src/zero/schema.ts:8` now has one localized `as unknown as` and no `as never`; `packages/sheet-db-schema/scripts/check-zero-schema-assertions.mjs:13-44` enforces checked-in ceilings, and `packages/sheet-db-schema/package.json:38-41` couples that guard to deterministic generation and regeneration-diff checks.

    **Original finding text.** **Generated Zero schema output is assertion-heavy.** `packages/sheet-db-schema/src/zero/schema.ts` contains roughly 150 `as unknown as`/`as never` assertions. Because it is generated, the recommendation is not hand-editing it: add generator type tests and a CI regeneration-diff check so changes in Effect/Zero types cannot silently expand the assertion surface.

20. **Effect SQL, Zero, and Drizzle maintained parallel schema representations** — Resolved by [PR #607](https://github.com/tiara-stack/tiara-stack/pull/607), reviewed at `1432d84063d5ad7167855e1d2a7e0ab511cce3c5` and merged as `dabb4cdf5f7ad05d0a5e0ebb10e81eb3c65ca787`. `packages/sheet-db-schema/src/schema.ts:45` establishes the Effect SQL schema as the canonical model; `packages/effect-zero/src/schema.ts:56-61` projects it into Zero; public Drizzle models are generated aliases; and `packages/sheet-db-schema/src/zero/schema.parity.test.ts:86-119` verifies Zero, public-model, relationship, and migration snapshot parity. The package scripts at `package.json:39-41` make regeneration drift fail CI.

    **Original finding text.** **Medium — Effect SQL/Zero/Drizzle maintain parallel schema representations.** `effect-sql-schema`, `effect-sql-kit`, `effect-zero`, `sheet-db-schema/src/schema.internal.ts`, public Drizzle casts, and generated Zero output form a long conversion chain. Establish one canonical model AST, make Drizzle/Zero projections pure generated artifacts, and require parity tests plus regeneration diffs for tables, indexes, relations, defaults, and migrations.

### PR #608 — Web OAuth boundary hardening

21. **Web OAuth boundaries lacked timeouts and full runtime validation** — Resolved by [PR #608](https://github.com/tiara-stack/tiara-stack/pull/608) at reviewed head `0834efa7bb8f996fe9f9ae15352944bd042389e0`. `packages/sheet-web/src/lib/oauth.ts:307-357` replaces global `fetch` with the Effect HTTP client, status/schema decoding, and a bounded timeout; `:451` uses `SheetWebOAuthCompletionInput` as the server-function validator; `:263-297` records token-safe request/refresh metrics and structured logs. `oauth.test.ts:90-216` covers invalid input, timeouts, refresh failures, and metric emission.

    **Original finding text.** **Medium — Web OAuth boundaries lack timeouts and full runtime validation.** `packages/sheet-web/src/lib/oauth.ts:203-220` calls global `fetch` without timeout; `completeSheetWebOAuthAuthorization` uses an identity `inputValidator` at `:304-306` instead of Schema validation. Refresh errors become `Option.none` without telemetry (`:222-241`). Use Schema-backed server-function inputs, an Effect HTTP client/timeout, and structured logs/metrics that never include tokens.

### PR #609 — Sheet configuration validation

22. **Sheet config parsing admitted invalid state** — Resolved by [PR #609](https://github.com/tiara-stack/tiara-stack/pull/609) at reviewed head `706825233626d6932b6d26220861cf8f25642f26`. `packages/sheet-apis/src/services/sheetConfig.ts:296-321` defines a grammar, integer bounds, and ordering check for hour ranges; schedule/team/runner parsing now accumulates typed row results through `validateConfigRows` (`:59-105`) instead of `Array.getSuccesses`; schema-backed key/value rows replace `[string, any][]`. The expanded test suite covers malformed, missing, non-numeric, out-of-bounds, reversed, and optional blank values.

    **Original finding text.** **Sheet config parsing admits invalid numeric state and hides row errors.** `hourRangeParser` at `packages/sheet-apis/src/services/sheetConfig.ts:207-213` destructures arbitrary `"start-end"` strings and calls `parseInt` without checking missing parts, `NaN`, bounds, or ordering. The schedule/team/runner parsers use `Array.getSuccesses` (`:75`, `:177`, `:229`), silently dropping invalid rows instead of returning diagnostics. The key/value range conversion uses `[string, any][]` at `:278` and `:345`. Replace these with explicit schemas for range grammar and an accumulated validation result that identifies sheet row/field failures.

23. **Sheet configuration failures could become silent partial configuration** — Resolved by [PR #609](https://github.com/tiara-stack/tiara-stack/pull/609) at reviewed head `706825233626d6932b6d26220861cf8f25642f26`. `validateConfigRows` fails the affected load on any rejected row, includes spreadsheet/sheet/range/row/field diagnostics, and increments `sheet_config_rejected_rows_total` with bounded attributes (`sheetConfig.ts:47-105`). Tests verify accumulated coordinates and metrics, preventing readiness from masking a partial configuration.

    **Original finding text.** **High — Sheet configuration failures can become silent partial configuration.** Invalid rows are discarded via `Array.getSuccesses`, and malformed hours become `NaN` (see Type Safety). In operational terms this can omit schedules/runners without failing readiness or producing actionable diagnostics. Fail the affected config load (or return a structured partial-result warning), include sheet/range/row coordinates, and publish a metric for rejected configuration rows.

### PR #610 — Ingress API public surface

24. **`sheet-ingress-api` exposed implementation concepts** — Resolved by [PR #610](https://github.com/tiara-stack/tiara-stack/pull/610) at reviewed head `868c861939ec99c5f7716053914af3d4d72987cf`. `packages/sheet-ingress-api/package.json` removes implementation-oriented entry points and the `./schemas/*` wildcard, replacing them with explicit contract/schema exports. `src/client-delivery.ts` and `src/dispatch.ts` define supported public contracts, while transport, middleware, token-cache, and workflow implementation symbols are consolidated behind the intentionally named server-only `./internal` adapter. Consumer imports were migrated across the backend packages, and the export map/build entries are explicit.

    **Original finding text.** **Medium — The public surface of `sheet-ingress-api` is broad and exposes implementation concepts.** `packages/sheet-ingress-api/package.json` exports `sheet-apis-internal`, `sheet-workflows-internal`, many middleware tags, and `./schemas/*`. Prefer explicit public contract entry points and keep internal transport/middleware modules behind package-private paths or a separate server-adapter package.

### PR #611 — Typed Zero dispatch registry

25. **Zero runtime dispatch used string paths and defects** — Resolved by [PR #611](https://github.com/tiara-stack/tiara-stack/pull/611) at reviewed head `82a989cf66a4028c3ae6abddc26ad76a9a44db6a`. `packages/typhoon-zero/src/server/http.ts:109-162` compiles and freezes an exact-name handler registry, performs own-key lookup, rejects prototype-related segments, and returns typed bad-request/not-found errors rather than throwing. `server/api.ts:5-42` places those errors in the HTTP contract, and `http.test.ts:46-105` covers valid, unknown, forbidden, missing, and renamed procedures.

    **Original finding text.** **Medium — Zero runtime dispatch uses string paths and defects.** `packages/typhoon-zero/src/server/http.ts:63-106` walks an object using attacker-supplied dot-separated names and throws `Error` when handlers are missing. Although handler shapes are checked, missing/renamed handlers become defects. Compile an immutable typed registry keyed by allowed procedure names and return a typed not-found/bad-request error; explicitly reject prototype-related path segments even if the current registry is trusted.

### PR #612 — Discord builder and guild-cache safety

26. **Public Discord builder utilities relied on suppressions** — Resolved by [PR #612](https://github.com/tiara-stack/tiara-stack/pull/612) at reviewed head `9634cfc4cf6765f813735b0b20061e30a926d85b`. The builder implementation replaces the cited broad `any`, unsafe declaration merging, and intentional TypeId suppressions with constrained state types and focused exported interfaces. `packages/dfx-discord-utils/test-d/builders.test-d.ts` adds positive and negative `tsd` coverage, and the package exposes a dedicated builders entry point.

    **Original finding text.** **Public Discord builder utilities depend on deliberate `any` and type-error suppression.** `packages/dfx-discord-utils/src/utils/commandBuilder.ts:69-74,648-676` and `messageComponentBuilder.ts:44-49` use explicit `any`, unsafe declaration merging suppressions, and intentional `@ts-expect-error` TypeId differences. These are public library APIs, so compiler upgrades can change behavior without a clear failure boundary. Add `tsd`-style positive/negative type tests and concentrate declaration merging behind smaller exported interfaces.

27. **Discord guild cache failures were silently converted to missing guilds** — Resolved by [PR #612](https://github.com/tiara-stack/tiara-stack/pull/612) at reviewed head `9634cfc4cf6765f813735b0b20061e30a926d85b`. `packages/sheet-apis/src/handlers/discord/http.ts:53-105` preserves per-guild diagnostics, bounds lookup concurrency, logs and counts each failure, and fails closed rather than returning partial results. `metrics/discord.ts` defines a bounded reason-tagged counter, and `http.test.ts:10-69` verifies success plus multi-failure logging/metrics. This closes the guild-cache finding; the broader fan-out finding remains because other external-I/O sites are untouched.

    **Original finding text.** **Medium — Discord guild cache failures are silently converted to missing guilds.** `packages/sheet-apis/src/handlers/discord/http.ts:84-106` maps every cache failure to `null` and returns only successes. This can present incomplete authorization/UI state without a log or error. Preserve per-guild diagnostics, log/metric failures, and decide explicitly whether partial results are safe.

### PR #620 — Fallow suppression cleanup and shared factories

28. **Fallow suppressions hid structural debt instead of tracking exceptions narrowly** — Resolved by [PR #620](https://github.com/tiara-stack/tiara-stack/pull/620) at reviewed head `ca94726ad52655c77c0b9f21d6a9e3219f8d06b4`. The PR removes all 73 source-level `fallow-ignore-*` pragmas and replaces accepted debt with exact, reviewed fingerprints in `.github/fallow-baselines/{dupes,dead-code,health}.json`; `.github/fallow-baselines/README.md:1-23` documents ownership, rationale, and the rule against new blanket pragmas. Shared factories and contracts remove repeated authorization layers, auth clients, command registration, workflow wiring, service status, timeline rows, SQL diff fixtures, and schema type machinery. The unsuppressed duplication result drops from 8.8% to 7.3% (8,602 lines), health findings fall from 94 to 92, and seven documented analyzer exceptions remain in the dead-code baseline. Remaining debt is visible and regression-gated rather than source-suppressed.

    **Original finding text.** **Medium — Fallow suppressions hide structural debt instead of tracking exceptions narrowly.** Blanket `// fallow-ignore-file complexity` appears on `sheet-workflows/src/services/dispatch.ts`, `sheet-ingress-server/src/index.ts`, and `sheet-db-schema/src/zero/api.ts`; dozens of production/test files suppress duplication. Full analysis still reports 39 clone families, 76 clone groups, and 3,166 duplicated lines (4.8%). Replace file-wide suppressions with issue-specific baselines/owners and refactor recurring middleware, client, and command wiring through shared factories.

### Reclassified after repository verification

- **Checked-in declarations contained non-portable inferred paths** — **No longer applicable.** Current `master` and the stack contain no tracked `src/**/*.d.ts` artifacts; local generated declarations are ignored and package declarations are emitted to `dist`/`.ts-out`. No stack PR is credited because the prior report's “tracked” premise was not true in the verified repository history.

  **Original finding text.** **Checked-in declarations contain non-portable inferred types.** `packages/effect-ai-codex/src/CodexError.d.ts:1-31` and `packages/effect-ai-kimi/src/KimiError.d.ts:2-39` refer to `import("node_modules/effect/dist/Types")` and `import("node_modules/effect/dist/Cause")`. These paths depend on one install layout and can break under pnpm layout changes, packaging, or consumers. There are 23 tracked declaration files under `src` across `effect-ai-codex`, `effect-ai-kimi`, and `effect-sql-kit`, alongside same-basename `.ts` sources. Suggested direction: remove generated declarations from `src`, generate declarations only into `dist`, and add a package smoke test that installs/packs each library and typechecks a consumer.

## Remaining problems

### Type Safety — 1 remaining

1. **AI provider adapters accept SDK data by assertion rather than validation.** `effect-ai-codex` and `effect-ai-kimi` still use `as any` metadata/event assertions and unsafe tool-argument parsing.

    **Original finding text.** **AI provider adapters accept SDK data by assertion rather than validation.** `packages/effect-ai-codex/src/CodexLanguageModel.ts:58-77,250-314,398-422` uses `as any` for response metadata and casts assembled response parts. `packages/effect-ai-kimi/src/KimiLanguageModel.ts:150-220` asserts SDK event payload variants and uses `Tool.unsafeSecureJsonParse` for tool arguments at `:191`. An upstream SDK event or Effect AI metadata shape change can silently produce invalid stream parts or defects. Suggested direction: declare provider metadata augmentation/types, validate SDK event payloads with Schema at the adapter edge, and map malformed tool arguments to a typed stream error.
### Code Organization — 2 remaining

2. **Workspace documentation and package inventory are stale.** `AGENTS.md`/`README.md` still cite Effect beta.56 and Vite+ 0.1.15 and omit newer packages/scripts.

    **Original finding text.** **Low — Workspace documentation and package inventory are stale.** `AGENTS.md` omits `effect-ai-codex`, `effect-ai-kimi`, `effect-sql-kit`, `effect-sql-schema`, `effect-zero`, and `tiara-review`. It describes Effect 4.0.0-beta.56 and vite-plus 0.1.15 (`AGENTS.md:227,243`; also `README.md:241,247`), while `pnpm-workspace.yaml:14-28` uses Effect beta.67 and `@tiara-stack/vite-plus` 0.2.4. Script descriptions at `AGENTS.md:135-140` also no longer match `package.json:6-11`.
3. **`bob` remains an empty workspace placeholder.** It still has no source implementation and reports success through placeholder scripts.

    **Original finding text.** **Low — `bob` is an empty workspace placeholder.** `packages/bob/package.json:8-11` provides only echoing build/lint/test scripts and has no source files, while `AGENTS.md:99-105` describes a real utility library. Remove the workspace or restore/relocate its implementation; echo scripts should not count as successful CI coverage.

### Tool Configuration — 1 remaining

4. **Critical packages still lack tests.** `sheet-db-server`, `effect-platform-apps-script`, `sheet-formulas`, and `start-atom` still have no test script.

    **Original finding text.** **Critical packages have no test script or very shallow coverage.** `sheet-db-server`, `effect-platform-apps-script`, `sheet-formulas`, and `start-atom` have zero tests and no package test script. `vibecord` has one test file limited to streaming helpers; `sheet-web` has only two. Add contract/startup tests for DB HTTP/auth, Apps Script HTTP behavior, formula parsing, SSR hydration, OAuth server functions, and Vibecord authorization/persistence. Avoid `--passWithNoTests` for production packages once a minimum suite is required.

### Safety / Operational Model — 5 remaining

5. **Kubernetes TokenReview remains partly unsafe.** PR #580 added Effect HTTP, status filtering, timeouts, retry, Schema decoding, redaction, and tracing, but no explicit response-size bound or HTTPS-only configured URL policy exists.

    **Original finding text.** **High — Kubernetes TokenReview has no explicit timeout or response-size bound.** `sheet-auth/src/plugins/sheet-oauth/index.ts:687-745` manually buffers the entire response and waits on Node request events without an AbortSignal/socket timeout. A stalled/misbehaving endpoint can hold requests indefinitely; an oversized response can consume memory. Use the Effect HTTP client with status filtering, schema decoding, timeout, body limit, redacted errors, and span/log annotations. The current code also accepts an `http:` TokenReview URL at `:701-703`; require HTTPS except in an explicit test/development mode.
6. **Several outbound fan-outs remain unbounded.** PR #612 bounds Discord guild-cache lookups, but Google Sheets processing, other sheet operations, Apps Script formula batches, and cache storage operations still lack explicit concurrency/backpressure policy.

    **Original finding text.** **Medium — Several outbound fan-outs are unbounded.** Examples include Discord guild-cache lookup (`packages/sheet-apis/src/handlers/discord/http.ts:84-94`), Google Sheets row/range processing (`services/google/sheets.ts:94-104,137-147`), numerous sheet operations (`services/sheet.ts`), Apps Script formula batches (`sheet-formulas/src/formulas.ts:93-100,466-473`), and cache storage operations (`dfx-discord-utils/src/cache/unstorage.ts`). Bound external I/O concurrency, distinguish pure CPU fan-out from network calls, and add rate-limit/backpressure tests.
7. **Debug `console` output bypasses structured telemetry.** The cited Sheet Config, auth shutdown, web session, and hydration paths still log directly.

    **Original finding text.** **Medium — Debug `console` output bypasses structured telemetry.** Production paths log directly in `sheet-apis/src/services/sheetConfig.ts:246-253,408-422`, `sheet-auth/src/server.ts:89-91`, `sheet-web/src/routes/__root.tsx:64-66`, `start-atom/src/start-atom-core.ts:69-75`, and extensively throughout `vibecord/src/sdk/index.ts`. Replace with Effect logging or the platform logger, set levels, add trace/session identifiers, and ensure question content, paths, IDs, and SDK results are redacted as appropriate.
8. **Production remains single-replica by default.** All application services and Zero Cache still default to one replica without production overrides.

    **Original finding text.** **Medium — Production is single-replica by default.** `charts/tiara-stack/values.yaml:78-220` sets every application service and Zero Cache to one replica, and `values-production.yaml` does not override replicas. PDBs are emitted only when replicas exceed one (`templates/pdb.yaml:1-19`). A node drain or rollout can therefore interrupt auth, ingress, bot, DB API, workflows, and web. Define per-service availability targets, raise stateless replicas, add anti-affinity/topology spread and HPA where safe, and document which stateful/Discord/workflow components require leader/shard semantics before scaling.
9. **NetworkPolicies still provide ingress isolation only.** No staged default-deny egress policy or required-destination allowlist has been added.

    **Original finding text.** **Medium — NetworkPolicies provide ingress isolation only.** `charts/tiara-stack/templates/networkpolicy.yaml` declares only `policyTypes: [Ingress]`; there is no default-deny egress or allowlist. This limits lateral inbound access but leaves compromised workloads able to reach arbitrary network destinations. Add an opt-in staged egress policy covering DNS, Kubernetes API/TokenReview, Postgres, Infisical, Discord, Google, OAuth, telemetry, and required public endpoints.

## Validation notes

- Finding accounting is **28 resolved + 1 no longer applicable + 9 remaining = 38 in scope**.
- PR #606 moved one Architecture / Design finding to resolved. PR #607 moved one Type Safety and one Architecture / Design finding to resolved. No new findings were added.
- At queue entry, both PRs were clean, green, and free of requested-changes reviews. Both merged successfully; their final queue-rebased SHAs are listed in the PR table, and `to merge` is absent after automatic cleanup.
- PRs #608–#612 moved seven findings to resolved: one each for #608, #610, and #611, and two each for #609 and #612. The broader outbound fan-out finding remains open because #612 addresses only the Discord guild-cache slice.
- PR #620 moved the remaining Fallow-suppression finding to resolved. The measured duplication/health/dead-code debt is not claimed to be eliminated; it is now unsuppressed, centrally owned, exactly baselined, reduced through shared factories, and regression-gated.
- PR #590–#596 branch names, final head SHAs, merged states, label absence, and final PR-head `workspace_ci` results were re-read from GitHub on 2026-07-19.
- **Original-text mapping:** all 38 in-scope entries include the exact problem paragraph from the July 10 scan; the four dedicated out-of-scope findings and two explicit non-problem notes remain excluded.
- **Split/merge handling:** PR #581 was previously displayed as one combined card, but it always represented two original findings—“Workflow dispatch is a god service” and “Domain/composition files are far beyond reviewable units.” They remain two separately counted entries here. No other in-scope finding was merged or split.
- Reference reports used for presentation were `/opt/data/tiara-stack-original-improvement-scan.md` and `/opt/data/plan-previews/tiara-stack-improvement-scan.html`.
