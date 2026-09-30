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
pnpm dlx fallow@2.88.2 audit
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
pnpm dlx fallow@2.88.2 audit
```

Run `pnpm build` when changes affect package exports, build configuration,
generated artifacts, or code paths not covered by tests. If the full workspace
is impractical, run the affected package scripts with `pnpm --filter` and
report skipped checks.

## Package scripts

Packages with source code generally expose `build`, `format`, `format:apply`,
`lint`, and, where applicable, `test` and `test:watch`. Database packages may
also expose `db:generate`, `db:migrate`, `db:push`, and `db:studio`. Check the
owning package's `package.json` for the current script definitions.
