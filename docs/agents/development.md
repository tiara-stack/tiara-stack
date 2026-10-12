# Development and validation

Run commands from the repository root. The workspace uses pnpm and vite-plus (`vp`). The authoritative scripts live in the root and package `package.json` files.

## Workspace commands

```bash
pnpm format
pnpm lint
pnpm test
pnpm build
pnpm check:tsc-build
pnpm checks
pnpm format:apply
pnpm check:agent-configs
pnpm dlx fallow@3.31.0 audit
```

Run `pnpm check:tsc-build` before `pnpm lint` or `pnpm checks`. `pnpm lint` and
`pnpm checks` validate the remaining `.agents/*.yaml` configs through
`pnpm check:agent-configs`; CI runs the same validator through the root lint
script. `pnpm checks` runs formatting, linting, agent config validation, and
tests; Fallow is a separate audit. Run
`pnpm format:apply` after proposing code changes. For a full code change, the
default local validation is:

```bash
pnpm format:apply
pnpm build
pnpm check:tsc-build
pnpm checks
pnpm dlx fallow@3.31.0 audit
```

Run `pnpm build` when changes affect package exports, build configuration,
generated artifacts, or code paths not covered by tests. If the full workspace
is impractical, run the affected package scripts with `pnpm --filter` and
report skipped checks.

## Nested conditional expressions

Vite+ linting enforces `tiara/no-nested-ternary` through the local Oxlint
JavaScript plugin in `packages/tooling-config/src/oxlint-plugins/`. Package
`vp lint src` uses the shared registration in `packages/tooling-config/src/vite.ts`;
the root staged check uses the registration in `vite.config.ts`. The rule is
strict unless its configuration explicitly opts into the repository baseline.

The baseline is a temporary allowance for inherited occurrences, not a file
ignore. Each entry names a repository-relative file, a SHA-256 fingerprint of
the normalized expression, a fingerprint of its normalized enclosing syntactic
site, and its allowed occurrence count. The JSON records the base revision and
fingerprint algorithm. Moving an identical expression to another site, editing
the expression or site, and occurrences beyond the recorded count remain
errors. Unrelated line breaks and whitespace do not change fingerprints.
Linting never writes or refreshes this file automatically.

To retire existing debt, remove its baseline entry or reduce its count when the
expression is refactored; then run `pnpm --filter tooling-config test` and lint
the affected package. To add an inherited allowance during a separately
reviewed debt-adoption change, compare the exact source expression and enclosing
site with the approved base revision, calculate their fingerprints with the
plugin's exported `fingerprintNestedTernaryExpression` and
`fingerprintNestedTernarySite` helpers, and add only that path/fingerprint pair
and count. Update the recorded base/algorithm only as part of that review.
Never add a file-wide exception or regenerate allowances from current lint
output alone. Verify root staged behavior with the isolated staged smoke test
when changing either Vite+ registration.

## Package scripts

Packages with source code generally expose `build`, `format`, `format:apply`,
`lint`, and, where applicable, `test` and `test:watch`. Database packages may
also expose `db:generate`, `db:migrate`, `db:push`, and `db:studio`. Check the
owning package's `package.json` for the current script definitions.
