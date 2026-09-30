# TiaraStack

TiaraStack is a pnpm monorepo for Google Sheets integration, Discord automation, durable workflows, and real-time collaborative applications.

## Start here

- Read [README.md](README.md) for the package map, architecture, and repository layout.
- Run commands from the repository root with `pnpm`.
- Run `pnpm check:tsc-build` before `pnpm lint` or `pnpm checks`.
- After code changes, use the validation workflow in [development.md](docs/agents/development.md).

## Workflow conventions

- Use Graphite for branch management, commits, and pull-request submission. Follow [Git and Graphite](docs/agents/git-workflow.md) for branch names, commit format, staging, and submission.
- The CI definition is [.github/workflows/ci.yml](.github/workflows/ci.yml). Keep the pull request in draft until required checks and hosted CodeRabbit review pass for its current head.
- When autonomous development is selected, use [.agents/autonomous-development.yaml](.agents/autonomous-development.yaml) for local reviewers and merge readiness. Run `open-code-review-delegate` before CodeRabbit; follow [Open Code Review delegation](docs/agents/open-code-review-delegation.md). Apply `to merge` only after the current head passes those gates; Graphite uses the label to admit the pull request to its merge queue.
- Use [.agents/ticket-coordinator.yaml](.agents/ticket-coordinator.yaml) for coordinated ticket runs, [.agents/ticket-routing.yaml](.agents/ticket-routing.yaml) for task-level recommendations, and [.agents/agentic-review.yaml](.agents/agentic-review.yaml) for direct agentic reviews.

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
