# Oxlint policy adoption baseline

`no-nested-ternary-baseline.json` records inherited sites from `master` at
`416a69d554f4fab5926c768b1d3537e94ab9adca`. The 205 nested ternaries across
90 files were collected from Oxlint 1.72.0's AST `ConditionalExpression`
visitor and paired with native `eslint/no-nested-ternary` diagnostics. These
nested-ternary occurrences are grandfathered by the JSON AST-site baseline
for the custom adoption rule. Inherited sites also retain a line-scoped
`oxlint-disable-line no-nested-ternary -- inherited master site` directive for
the native rule; the adapter removes that marker from the expression
fingerprint. Separately, paired block directives cover inherited native
unsafe-assertion and template-interpolation sites: an assertion pair covers
its `as` clause, and a template pair covers one interpolation expression.
The adapter requires the same file,
AST structural path, enclosing named AST
anchors, and normalized expression identity. Named function, variable,
class, and member anchors distinguish equivalent expression shapes in
different declarations even when their structural paths match. It tracks
multiplicity only for sites with the same complete identity, so a replacement,
a move to another named declaration, or an added duplicate does not inherit an
allowance. For runtime-policy sites inside anonymous test callbacks, the
identity also includes the callback's static test labels. It does not use the
top-level statement ordinal, so unrelated module declarations and added
sibling cases do not move an existing case's identity. A replacement at a
different callback or declaration does not inherit an allowance. Only
actual parser comments containing inherited suppression markers are removed
from an expression fingerprint; identical text inside string literals remains
part of the expression.

For controlled Effect-test sleeps, a clock exemption requires an executed
synchronization path and enough statically known clock advancement before the
matching fiber is joined. Separate reachable adjustments are summed. The
preview-auth adapter path uses its five-second adapter timeout only when the
factory call resolves to the canonical `makePreviewAuth` import. A same-named
local function or import from another module does not grant the timeout. A
clock advance that cannot reach either the sleep deadline or that timeout does
not exempt the sleep; only guaranteed, reachable advances count.

Enforcement in the root and staged Vite+ routes starts only when the root Vite+
configuration imports and applies `lintPolicy`; the foundation and migration
layers defer this step. After activation, the native rule remains error-level
in root, shared package, and staged configs.
The baseline corpus includes the full staged-reachable roots (`packages/**/*`,
`deploy/**/*`, `.github/**/*`, and the root `vite.config.ts`), not only package
`src/` paths. The deploy parity-gate site is inherited at its exact AST location.
The adapter uses Oxc's parser AST and source text; it has no parallel lexer.
The baseline file SHA-256 is pinned in `effect-policy.mjs`, so adding entries
requires an explicit plugin change and review. The seven inherited custom-rule
sites are keyed by rule, file, structural path, enclosing named anchors, test
callback labels where applicable, and expression text. The baseline identity
migration was regenerated from exact master Git blobs. Its occurrence ledger
records each master blob and parser source span, and verifies one-to-one
equality of the previous rule/path/expression multiplicities: 205 nested
ternaries and seven custom-policy sites. The original 725 native type-aware
allowances (691 unsafe assertions and 34 nullish templates) were also rekeyed
one-to-one for the enclosing callback identity.

The two TypeScript built-ins remain native type-aware errors. A complete native
diagnostic inventory later found 26 additional child occurrences already
present in the exact master source but hidden inside inherited sites: nine
unsafe assertions and 17 template interpolations. Each child was linked to its
master blob and parser span before it was added. The current pinned baseline
therefore contains 712 unsafe-assertion occurrences and 51
template-interpolation occurrences. The TIA-249 rebase removed twelve inherited
unsafe assertions: one bounded action decode in `commands.ts` and eleven Schema
decodes in `preview-sessions.ts`. Those sites were removed from the baseline.
PASS19 enrolls exactly 28 base-proven
`typescript/no-unsafe-type-assertion` occurrences in
`packages/sheet-web/src/routeTree.gen.ts`, already present in the generated
route tree but outside the earlier lint target. Each has an exact paired native
directive and a distinct AST-site identity. No other route-tree or new source
occurrence is enrolled. The original 725-site migration remains historical and
unchanged. One original master unsafe assertion in the connected-preview
doctor lookup was later resolved by the runtime-safe fallback and pruned
one-to-one. The TIA-249 cleanup timing inspection replaced three inherited
unchecked SQL-row assertions with Effect Schema decoding and removed those
three baseline entries. The 26 additional master-proven child occurrences
(nine unsafe assertions and 17 template interpolations) remain active.

The sheet-web TanStack Start config installs
`createGeneratedRouteAdoptionPlugin` as a Router GeneratorPlugin. It decorates
the public route-tree build result before TanStack formats, writes, and caches
it, so ordinary builds and development regeneration keep the same 28 accepted
pairs. The helper uses the existing native site identity function; changed,
moved, duplicate, and new assertions remain visible to the type-aware rule.

The original 725 legacy line markers were migrated one-to-one in 219 files to
paired block directives without changing executable TypeScript ASTs or
baseline identities. The adapter binds each pair to exactly one assertion or
interpolation range. Each template interpolation has its own candidate range,
including multiple expressions in the same template or line. For these
type-aware native rules, it rejects unpaired, malformed, expanded, duplicate,
moved, or changed sites; line-wide native suppressions are rejected. This keeps
safe widening and permitted template values under the native type-aware rules
while making additional same-line diagnostics visible.
Each suppression has a parser-backed identity from rule, enclosing named
anchors, anonymous callback labels where present, structural AST path, and AST
shape. Unrelated top-level statement position is excluded from the identity.
Effect test identities also include whether a callback uses `it.effect` or
`it.live` and its occurrence among same-label sibling callbacks. This prevents
a resolved live callback from grandfathering the same runtime call if it is
changed back to effect mode. The initial master-proven manifest contained seven
custom policy sites. All
seven original sites have now been resolved to `it.live` and pruned one-to-one
across the P6, P13, and P14 migrations, leaving zero active custom policy
allowances. The custom adoption checks remain active for future sites. Native
baseline counts now stand at 712 unsafe assertions and 51 template
interpolations.
The identity is matched with multiplicity, so removing an inherited site does
not create room for another site. The adapter also rejects stale or moved
suppressions. At initial migration, all 725 original diagnostic expressions were present in `master`: 695 match exactly and 30 differ only by formatting (whitespace or a
trailing object-type semicolon). Oxlint's JavaScript plugin API does not expose
type information, so Oxlint is the detector and the adapter validates the
precise suppression site.

The configured root and shared Vite+ routes do not honor ESLint-compatible
disable directives for the type-aware built-ins. New unsafe-assertion and
template-expression exceptions must use the adapter's exact paired Oxlint
directives; ESLint comments cannot hide those native diagnostics.

Type-aware validation belongs to a specific source/config candidate. Run
`pnpm check:tsc-build` before type-aware lint after changing TypeScript or lint
configuration inputs, then follow the validation commands in
`docs/agents/development.md`. Do not carry type outputs across changed inputs
or describe validation as current until it has run for that candidate.

The custom rules are deliberately narrow:

- `effect-predicate` checks exported reusable tagged predicates and private
  `isX` helpers referenced from at least two other sites in the module. It
  catches direct `_tag` comparisons and relevant `instanceof` checks. One-off
  local guards, ordinary runtime adapters, and unrelated `instanceof` use stay
  allowed.
- `effect-match` checks terminating two-or-more-case `_tag` switches and
  three-or-more same-discriminant guard chains, including `if`/`else if` and
  sequential early-return forms. One-off and two-case guard chains remain
  allowed; switches with fallthrough remain allowed.
  A terminal two-case `switch` is still considered multi-case dispatch; two
  simple early-return guards remain ordinary control flow.
- `effect-live-test` resolves `@effect/vitest` test imports and aliases, test
  modifiers including `.only`, `.prop`, `.each`, `.runIf`, and `.skipIf`, and
  named or namespace `describe`/`suite` imports from `vitest` and
  `@effect/vitest`. It follows Node filesystem/subprocess/timer imports,
  namespace members, stable local function aliases, and stable `process.env`
  aliases inside the matching `it.effect` callback. Process-object and named
  environment imports are resolved separately; unrelated `node:process`
  exports do not become environment objects. It accounts for locally shadowed
  names and ignores unrelated objects named `it`; `it.live` callbacks are
  exempt.
- `controlled-test-timeouts` flags fixed positive Node timer delays and
  stable local aliases to timers, and `Effect.sleep` durations only when the
  resulting Effect is executed in a deterministic `it.effect` test. Effects
  returned as values from non-flattening APIs such as `Effect.map`,
  `Effect.sync`, or `Effect.succeed` do not count as running sleeps. A
  controlled `TestClock` adjustment exempts an executed sleep only when the
  same already-scheduled sleep is forked, advanced, and joined; an adjustment
  before scheduling, after the wait, inside a conditional or short-circuit
  arm, or on an unrelated path does not control it. Known reachable
  advances are summed before the matching fiber join.
  The rule also accepts a binding-matched `Deferred` handshake when an executed
  adapter or HTTP callback signals before sleeping and the test forks that
  operation, awaits the same `Deferred`, advances the test clock, and joins the
  same fiber. `it.live` and explicitly named integration tests remain exempt.
  The connected-preview doctor maps unknown provider check IDs to the generic
  `prerequisite-unavailable` diagnostic while retaining the exhaustive table
  for known prerequisite IDs.

The designated contract registry is:

| Rule                            | Designated name                                                | Canonical closed contract                                                                                                          | Required form                                                                                 |
| ------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `exhaustive-diagnostic-tables`  | `doctorFailureCodes`                                           | `ConnectedPreviewPrerequisiteId`, derived from the canonical `prerequisites` list in `developer-launcher/src/connected-preview.ts` | `satisfies Readonly<Record<ConnectedPreviewPrerequisiteId, Diagnostic["code"]>>`              |
| `exhaustive-diagnostic-tables`  | `safeStagedSourceSnapshotValidationReasons`                    | `StagedSourceSnapshotValidationReason`, exported from `sheet-workflow-contracts/src/stagedSource.ts` (nine members)                | imported canonical union and `satisfies Record<StagedSourceSnapshotValidationReason, true>`   |
| `preserve-unknown-evidence`     | `WorkflowRecreationRecoverySchema.ordinaryReassignmentBlocked` | forward contract guard; no matching schema or producer exists at this source revision                                              | `Schema.NullOr(Schema.Boolean)`; preserve nullable evidence if this designated shape is added |
| `canonical-lifecycle-contracts` | `LifecyclePhase`                                               | `developer-launcher/src/owned-application-contract.ts`                                                                             | import from `./owned-application-contract`                                                    |

The sanitizer's nine members are `missing-revision`,
`snapshot-completion-mismatch`, `excluded-or-unsafe-path`, `duplicate-path`,
`invalid-mode`, `invalid-base64-content`, `invalid-package-manifest-encoding`,
`invalid-package-manifest`, and `incomplete-workspace-manifest`. The TIA-249
read-only reference has this typed mapping and a separate `safeActivationFailureReasons`
Set used for membership. The Set remains legal; the typed table is what proves
the canonical nine-code mapping is complete. Its transition reason schema is
defined in that separate reference. `WorkflowTransitionReasonSchema` and
`WorkflowTransitionReason` are not exports of the current `sheet-workflow-contracts`
package and are not designated by this version of `canonical-lifecycle-contracts`.
The rule tests the actual `LifecyclePhase` export with import aliases, wrong-module
controls, and local-copy rejection.

- `exhaustive-diagnostic-tables` has two named designations. `doctorFailureCodes`
  must satisfy `Readonly<Record<ConnectedPreviewPrerequisiteId,
Diagnostic["code"]>>`, where the closed union is derived from the canonical
  prerequisite list. The sanitizer table `safeStagedSourceSnapshotValidationReasons`
  must satisfy `Record<StagedSourceSnapshotValidationReason, true>` using the
  imported contract union. That union has nine members in
  `sheet-workflow-contracts/src/stagedSource.ts`. This protects the complete
  nine-code sanitizer mapping; the separate `safeActivationFailureReasons` set
  is an allowlist used for membership and is not blanket-banned. Other sets and
  maps remain allowed.
- `preserve-unknown-evidence` applies only to the designated
  `WorkflowRecreationRecoverySchema.ordinaryReassignmentBlocked` shape and the
  named producer cases. No matching schema or producer is present in this source
  revision. The parser fixtures preserve the requested forward contract: if the
  field is added, its schema must remain `Schema.NullOr(Schema.Boolean)` and its
  producer must retain null rather than coerce or default it. Other nullable
  Boolean fields, such as `ConversationsUpdateConfigAndDeliverInput.patch.running`,
  stay outside the designation.
- `canonical-lifecycle-contracts` uses this explicit designation registry:

  | Contract name    | Canonical definition                                   | Import source                  |
  | ---------------- | ------------------------------------------------------ | ------------------------------ |
  | `LifecyclePhase` | `developer-launcher/src/owned-application-contract.ts` | `./owned-application-contract` |

  Import aliases are accepted, but local copies and imports from another module
  are rejected. Unrelated enums, schema literals, and unregistered names such as
  `WorkflowTransitionReason` remain allowed until their canonical exports exist
  in this codebase.

- The generated Zero schema uses `return null!;` in `customType<T>` so its
  generated output is a safe `never` widening. The Effect Zero generator and
  generated file carry the same change, so normal generation retains it.

`deploy/kubernetes/scripts/tsconfig.json` supplies Node ambient types to the
staged-reachable parity script, which is outside the root project references.
That keeps `vp check --fix` effective for this path while preserving
`typeAware` and `typeCheck`. The script's inherited unsafe assertions and
nullish interpolations were resolved with Schema decoding and control-flow
narrowing, so its staged check passes without suppressions.

Focused regressions live in `packages/tooling-config/test`. The integration test
uses a temporary baseline override and an isolated `GIT_INDEX_FILE`; it does not
change the developer's real index.
