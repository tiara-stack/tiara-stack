# TiaraStack Monorepo Package Overview

This monorepo contains the following packages:

> **Note:** For the complete project structure and architecture diagrams, see the [README.md](./README.md).

## Core Infrastructure Packages

### `typhoon-core` (packages/typhoon-core)

Shared utilities library providing schema transformation helpers, standardized error types, config helpers, and common utilities used across the monorepo.

**Dependencies**: `@standard-schema/spec` (peer: `effect`)

### `typhoon-zero` (packages/typhoon-zero)

Shared Rocicorp Zero integration library providing typed Zero API definitions, Effect-based Zero client helpers, Zero error schemas, readonly JSON schemas, and reusable Zero HTTP server layers.

**Dependencies**: `@rocicorp/zero`, `typhoon-core` (peer: `effect`)

## Application Packages

### `sheet-apis` (packages/sheet-apis)

Backend API server for Google Sheets integration using Effect's HttpApiBuilder, providing HTTP API handlers for sheet operations, calculations, guild configuration, and message management.

**Dependencies**: Effect ecosystem, `@googleapis/sheets`, `@rocicorp/zero`, Playwright, `sheet-auth`, `sheet-db-schema`, `sheet-ingress-api`, `dfx-discord-utils`, `typhoon-core`, `typhoon-zero`

### `sheet-workflows` (packages/sheet-workflows)

Workflow runtime service for sheet dispatch and auto-checkin workflows using Effect Workflow/Cluster. It accepts workflow dispatch RPCs, executes durable command/button workflows, coordinates auto-checkin enqueueing, calls `sheet-apis` through ingress contracts, and stores workflow runner/message state in PostgreSQL.

**Dependencies**: Effect platform/node/opentelemetry/sql stack, `sheet-auth`, `sheet-ingress-api`, `dfx-discord-utils`, `typhoon-core`, `typhoon-zero`

### `sheet-ingress-api` (packages/sheet-ingress-api)

Shared Effect HttpApi contract and schema package for sheet ingress routes. It exposes sheet API groups, workflow dispatch API groups, Discord application/cache API groups, middleware tags, request/response schemas, `SheetApisApi`, `SheetApisRpcs`, `SheetWorkflowsApi`, and `SheetWorkflowsRpcs`.

**Dependencies**: `dfx-discord-utils`, `typhoon-core`, `typhoon-zero` (peer: `effect`)

**Exports**: `.`, `./api`, `./api-groups`, middleware tag exports, `./sheet-apis`, `./sheet-apis-rpc`, `./sheet-workflows`, `./sheet-workflows-rpc`, `./schemas/*`

### `sheet-ingress-server` (packages/sheet-ingress-server)

Ingress/proxy server that fronts sheet API, workflow dispatch, and sheet bot/Discord routes. It handles authorization, CORS, telemetry, auth resolution, message lookup, and forwarding to `sheet-apis`, `sheet-workflows`, and sheet bot services.

**Dependencies**: Effect platform/node/opentelemetry stack, `sheet-auth`, `sheet-ingress-api`, `dfx-discord-utils`, `typhoon-core`

### `sheet-db-server` (packages/sheet-db-server)

Database server providing Zero (real-time sync) HTTP API for the sheet database schema using Rocicorp Zero.

**Dependencies**: Effect ecosystem, `@rocicorp/zero`, `drizzle-orm`, `postgres`, `sheet-db-schema`, `typhoon-core`, `typhoon-zero`

### `sheet-db-schema` (packages/sheet-db-schema)

Database schema definitions using Drizzle ORM for PostgreSQL with Zero integration.

**Dependencies**: `@rocicorp/zero`, `drizzle-orm`, `drizzle-zero`, `postgres`, `typhoon-core`, `typhoon-zero` (peer: `effect`)

### `sheet-auth` (packages/sheet-auth)

Authentication service using BetterAuth for Discord OAuth, JWT tokens, and Kubernetes OAuth integration.

**Dependencies**: Effect ecosystem, `better-auth`, `@better-auth/oauth-provider`, `hono`, `@hono/node-server`, `drizzle-orm`, `postgres`, `ioredis`, `unstorage`, `jose`, `typhoon-core`

**Peer Dependencies**: `@better-fetch/fetch`, `@effect/opentelemetry`, `@standard-schema/spec`, `effect`, `nanostores`

**Exports**: `.`, `./client`, `./model`, `./schema`, `./server`, `./plugins/kubernetes-oauth`, `./plugins/kubernetes-oauth/client`, `./plugins/kubernetes-oauth/rpc-authorization`

### `sheet-web` (packages/sheet-web)

Web application for the sheet system built with TanStack Start, providing a dashboard for guild management, scheduling, and calendar views.

**Dependencies**: TanStack Start/React ecosystem, Effect, `better-auth`, `sheet-apis` (workspace/type-level API dependency; runtime HTTP calls go through ingress), `sheet-auth`, `sheet-ingress-api`, `start-atom`, `typhoon-core`, `typhoon-zero`, shadcn/ui components, Recharts

### `sheet-bot` (packages/sheet-bot)

Discord bot application that uses the shared ingress API contracts to provide Discord commands and interactions for sheet workflows.

**Dependencies**: Effect ecosystem, `dfx`, `dfx-discord-utils`, `discord-api-types`, `@discordjs/builders`, `ts-mixer`, `handlebars`, `sheet-auth`, `sheet-db-schema`, `sheet-ingress-api`, `typhoon-core`

### `sheet-formulas` (packages/sheet-formulas)

Google Apps Script formulas library for performing calculations and operations on Google Sheets. Deployed as a Google Apps Script project.

**Dependencies**: Effect, `core-js`, `effect-platform-apps-script`, `sheet-ingress-api`, `typhoon-core`

### `vibecord` (packages/vibecord)

Discord bot application for VibeCord, providing workspace and session management with ACP (Agent Client Protocol) integration.

**Dependencies**: `discord-api-types`, `dfx`, `dfx-discord-utils`, `drizzle-orm`, `better-sqlite3`, `@opencode-ai/sdk`, `simple-git`, `diff`, `c12`, `remend`, `effect`

**Database Scripts**: `db:generate`, `db:migrate`, `db:push`, `db:studio`

## Utility Packages

### `bob` (packages/bob)

Configuration builder utility library for building type-safe configuration objects with validation using Standard Schema.

**Dependencies**: `@standard-schema/spec`

**Dev Dependencies**: `arktype` (for testing)

### `dfx-discord-utils` (packages/dfx-discord-utils)

Discord utilities library extending dfx (Discord Effect) with caching, command builders, and interaction helpers.

**Dependencies**: `@discordjs/builders`, `discord-api-types`, `ts-mixer`, `typhoon-core`, `unstorage`

**Peer Dependencies**: `effect`, `@effect/platform-node`, `dfx`

### `effect-platform-apps-script` (packages/effect-platform-apps-script)

Effect Platform HTTP client implementation for Google Apps Script environment.

**Peer Dependencies**: `effect`

**Dev Dependencies**: `@types/google-apps-script`

### `start-atom` (packages/start-atom)

Integration library connecting TanStack Start with Effect Atom for server-side rendering (SSR) compatible state management.

**Dependencies**: `@tanstack/router-core`

**Peer Dependencies**: `@effect/atom-react`, `effect`, `react`, `@tanstack/react-router`, `@tanstack/react-start`, `@tanstack/router-core`

## Workspace Scripts

The following workspace-level scripts are defined in `package.json`:

- **`format`**: `vp run -r format` - Runs format checks across packages that define a format script
- **`lint`**: `vp run -r lint` - Runs lint plus type-aware TypeScript checks across packages that define a lint script
- **`test`**: `vp run -r test` - Runs tests across packages that define a test script
- **`build`**: `vp run -r build` - Builds all packages
- **`checks`**: `pnpm format && pnpm lint && pnpm test` - Runs format checks, lint/type checks, and tests across packages that define those scripts
- **`format:apply`**: `vp run -r format:apply` - Applies formatting across all packages that define a format script

Fallow is not included in `pnpm checks`. Run `npx fallow audit` separately from the repo root to match the PR CI changed-code audit.

Run these scripts from the repo root using `pnpm <script>`.

Run `pnpm format:apply` every time after you finish proposing a change to correctly format all the code.

After making code changes, run the local validation needed to catch CI failures before handing work back. The default is `pnpm format:apply`, `pnpm checks`, and `npx fallow audit` from the repo root; also run `pnpm build` when changes affect package exports, build configuration, generated artifacts, or code paths not covered by tests. If a full workspace command is not practical, run the affected package scripts with `pnpm --filter <package> <script>` and explicitly report which command was skipped and why.

## Package Scripts

Packages with source code generally have the following standard scripts:

- **`build`**: Compiles TypeScript and creates distribution bundles
- **`format`**: Checks formatting via `vp fmt --check`
- **`format:apply`**: Applies formatting via `vp fmt`
- **`lint`**: Runs linting via `vp lint src`; in this repo's Vite+ packages it also performs type-aware TypeScript checking because `lint.options.typeCheck` is enabled
- **`test`**: Runs tests via `vp test run` where applicable
- **`test:watch`**: Runs tests in watch mode via `vp test` where applicable

Database-related packages (`sheet-auth`, `vibecord`) have additional scripts:

- **`db:generate`**: Generates Drizzle migrations
- **`db:migrate`**: Runs Drizzle migrations
- **`db:push`**: Pushes schema changes to database
- **`db:studio`**: Opens Drizzle Studio (vibecord only)

## Test Guidelines

Effect-based tests should use the Effect v4 beta `@effect/vitest` helpers. Import `describe`, `expect`, `it`, and `layer` from `@effect/vitest` when a test runs an `Effect`; keep plain Vitest imports such as `vi`, `beforeEach`, and `afterEach` from `vitest`.

- Prefer `it.effect("case", () => Effect.gen(function* () { ... }))` for deterministic Effect tests. Use `const value = yield* program` instead of `await Effect.runPromise(program)`.
- Use `it.live` when the test depends on real timers, subprocesses, real filesystem behavior, process environment mutation, or runtime services whose behavior would change under the test runtime.
- Do not introduce `Effect.runPromise` or `Effect.runPromiseExit` in `*.test.ts`, except when the test is explicitly validating those runtime APIs.
- For failure assertions, use `const exit = yield* Effect.exit(program)` and inspect `Exit`, `Cause`, or tagged errors. Avoid Promise `.rejects` assertions for Effect programs.
- Helpers named `run`, `provide`, or `runWith...` in Effect tests should return an `Effect`, not a `Promise`.
- Prefer `Layer.succeed(Tag, mock)` and shared `Layer` values for reused dependency setup. Use `layer(TestLayer)("suite", (it) => { ... })` where it reduces repeated `Effect.provide` calls.
- Put stateful mocks inside `Layer.sync` so each test gets isolated state unless shared state is intentional.
- Keep ordinary synchronous schema, parser, and data transformation tests as plain `it`.
- Avoid explicit `TestClock.layer()` when `it.effect` already provides test services, unless the test needs a custom clock setup.

## Guidelines on Graphite Commit Messages For This Project

We use Graphite for managing stacked pull requests. The following guidelines are to be followed for `gt create` and `gt modify` commands.

- For the first commit you are creating
  - If you are on a trunk branch (master) use `gt create` to create the commit on a new branch. **DO NOT commit directly to master**
  - Otherwise, ask the developer if they want to create the commits on a new branch (`gt create`) or add commits to the current branch (`gt modify -c`).
  - When working in a git worktree (vibecord session)
    - Check if the branch name follows `<username>/<branch-name>` format
    - If the branch name does NOT follow the format, rename it: `git branch -m <username>/<new-branch-name>`
    - Track with trunk: `gt track --parent master`
    - Use `gt modify -c` for all commits (do NOT use `gt create`)
- For the rest of the commits, use `gt modify -c`.
- When you create the commits on a new branch
  - If the developer mentions that the commits is related to a linear issue, look up the git branch name to use via the linear MCP server. If the linear MCP server does not exist, tell the developer and stop proceeding.
  - Otherwise, come up with a descriptive branch name with the user prepended before the slash e.g. `<username>/branch-name`. **ALWAYS use the actual username. DO NOT directly put `<username>` in the branch name**
  - **ALWAYS set the branch name. DO NOT leave the branch name blank.**
- Use conventional commit message. If the work is done inside a package, use the name of the package (or a shortened version if it is not ambiguous) of the changes as the scope of the commit. Optionally, you could also append the area where the work was done inside the package e.g. `feat(example-package/utils): implement new utility x`
- There is no need to list functions or symbols affected by the changes separately from the main commit message body.
- Use -m for new line in the commit message, and do not use \n anywhere.

  GOOD:
  - `gt create matthew/abc-123-linear-issue-branch-name -m "subject" -m "line1" -m "line2"  ...`
    This correctly sets the branch name (for a user named "matthew" against a linear issue abc-123) and supplies commit message in the correct format for a new branch.
  - `gt modify -c -m "subject" -m "line1" -m "line2"  ...`
    This correctly supplies commit message in the correct format for the current branch.

  BAD:
  - `gt create matthew/abc-123-linear-issue-branch-name -m "subject\nline1\nline2\n..."`
    This correctly sets the branch name (for a user named "matthew" against a linear issue abc-123) BUT supplies commit message in a bad format.
  - `gt create matthew/abc-123-linear-issue-branch-name -m "subject" -m "line1\nline2\n..."`
    This correctly sets the branch name (for a user named "matthew" against a linear issue abc-123) BUT supplies commit message in a bad format.
  - `gt create -m "subject" -m "line1" -m "line2"  ...`
    This supplies commit message in the correct format BUT forgot to set the branch name for a new branch.
  - `gt create <username>/abc-123-linear-issue-branch-name -m "subject" -m "line1" -m "line2"  ...`
    This supplies commit message in the correct format BUT wrongly set the branch name with a placeholder username.
  - `gt modify -c -m "subject\nline1\nline2\n..."`
    This supplies commit message in a bad format.
  - `gt modify -c -m "subject" -m "line1\nline2\n..."`
    This supplies commit message in a bad format.

## Guidelines on Library Usages

### Effect.ts

This project utilizes the Effect library for composability and type-safety. The catalog version of the library being used is 4.0.0-beta.56. Use Effect/Schema for runtime validation except where existing code uses another validation library, or otherwise stated.

Use Effect's `Predicate` module for reusable predicate/type-guard helpers instead of hand-written comparison checks such as raw `typeof`, `instanceof`, tag equality, or property checks. Prefer `Predicate.isTagged`, `Predicate.hasProperty`, primitive predicates, and predicate combinators so type guards are consistent and composable.

Avoid large `if`/`else` chains and `switch` statements for value dispatch. Prefer Effect's `Match` module when matching tagged unions or structured cases, and prefer typed lookup tables for simple enum/string-to-value mappings. Keep imperative branching only when it is genuinely clearer for stateful algorithms, early exits, or low-level parser loops.

Use Effect's HTTP client APIs for outbound HTTP requests. When checking HTTP response status, prefer provided helpers such as `HttpClientResponse.filterStatusOk` over manual `status >= 200 && status < 300` checks, and compose body decoding through the Effect HTTP response helpers where practical.

### Arktype

This project utilizes the ArkType library for runtime type validation in some limited case. The version of the library being used is 2.1.19.

### vite-plus

This project uses vite-plus (`vp`) for monorepo build, lint, format, and test tooling. The catalog version is 0.1.15.

## Package Dependency Graph

```
sheet-web
  ├─ sheet-apis (workspace/type-level dependency; runtime HTTP calls go through ingress)
  ├─ sheet-auth
  ├─ sheet-ingress-api
  ├─ start-atom
  ├─ typhoon-core
  └─ typhoon-zero

sheet-apis
  ├─ sheet-auth
  ├─ sheet-db-schema
  ├─ sheet-ingress-api
  ├─ dfx-discord-utils
  ├─ typhoon-core
  └─ typhoon-zero

sheet-workflows
  ├─ sheet-auth
  ├─ sheet-ingress-api
  ├─ dfx-discord-utils
  ├─ typhoon-core
  └─ typhoon-zero

sheet-bot
  ├─ sheet-auth
  ├─ sheet-db-schema
  ├─ sheet-ingress-api
  ├─ dfx-discord-utils
  └─ typhoon-core

sheet-formulas
  ├─ sheet-ingress-api
  ├─ effect-platform-apps-script
  └─ typhoon-core

sheet-ingress-server
  ├─ sheet-auth
  ├─ sheet-ingress-api
  ├─ dfx-discord-utils
  └─ typhoon-core

sheet-ingress-api
  ├─ dfx-discord-utils
  ├─ typhoon-core
  └─ typhoon-zero
  (peer dependency: effect)

sheet-db-server
  ├─ sheet-db-schema
  ├─ typhoon-core
  └─ typhoon-zero

sheet-db-schema
  ├─ typhoon-core
  └─ typhoon-zero
  (peer dependency: effect)

sheet-auth
  └─ typhoon-core

dfx-discord-utils
  └─ typhoon-core
  (peer dependencies: effect, @effect/platform-node, dfx)

start-atom
  └─ @tanstack/router-core
  (peer dependencies: @effect/atom-react, effect, react, @tanstack/react-router, @tanstack/react-start, @tanstack/router-core)

effect-platform-apps-script
  (peer dependency: effect)

bob
  (no workspace dependencies)

typhoon-core
  (peer dependency: effect)

typhoon-zero
  └─ typhoon-core
  (peer dependency: effect)

vibecord
  └─ dfx-discord-utils
```
