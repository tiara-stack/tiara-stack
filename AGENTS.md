# TiaraStack

TiaraStack is a pnpm monorepo for Google Sheets integration, Discord automation, durable workflows, and real-time collaborative applications.

## Start here

- Read [README.md](README.md) for the package map, architecture, and repository layout.
- Run commands from the repository root with `pnpm`.
- Run `pnpm check:tsc-build` before `pnpm lint` or `pnpm checks`.
- After code changes, use the validation workflow in [development.md](docs/agents/development.md).

## Effect-first implementation

Use Effect as the default for new application and library code whenever the
workspace provides an Effect API. Reach for the Effect ecosystem first for
CLI commands, filesystem and subprocess work, outbound HTTP, HTTP servers,
configuration, SQL and migrations, durable workflows, cluster/RPC services,
AI integrations, reactive state, observability, concurrency, resource
lifecycles, and tests (`@effect/vitest`). Use Effect Schema for codecs and
configuration, and Effect services, layers, typed errors, and data types for
dependency injection and domain modeling. Keep effects composable and typed
with their required services and errors; provide platform layers at runtime
boundaries. Use direct platform APIs only for existing non-Effect integrations,
runtime entrypoint adapters, or when the owning package has an established
non-Effect convention. Read [Effect and library usage](docs/agents/effect-guidelines.md)
before implementing any of these branches; its rules are mandatory for the
change.

## Focused guidance

Read only the guidance relevant to the task:

- [Development and validation](docs/agents/development.md): workspace commands and package scripts.
- [Testing](docs/agents/testing.md): Effect and Vitest conventions.
- [Git and Graphite](docs/agents/git-workflow.md): branches, incremental commits, and submission.
- [Effect and library usage](docs/agents/effect-guidelines.md): mandatory Effect, Predicate, Match, platform, HTTP, testing, and type-safety rules.
- [Domain documentation](docs/agents/domain.md): context maps, glossaries, and ADRs.
- [Issue tracking](docs/agents/issue-tracker.md): Linear workflow and ticket operations.
- [Triage labels](docs/agents/triage-labels.md): canonical issue-label mappings.
