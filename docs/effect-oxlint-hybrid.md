# Effect Oxlint Hybrid Experiment

This branch tries a hybrid path for Effect diagnostics:

- `effect-lint` is a workspace CLI package that delegates to the native `@effect/language-service diagnostics` engine.
- `vp lint` also loads a small oxlint JS plugin for syntax-only Effect style checks.
- Type-aware Effect diagnostics stay in the native language-service runner because oxlint JS plugins do not expose TypeScript checker data.

## CLI

```sh
effect-lint --project tsconfig.json
effect-lint --project 'packages/*/tsconfig.json' --format github-actions
```

The wrapper accepts repeated `--project` values and glob patterns. It forwards `--format`, `--strict`, `--progress`, `--severity`, and `--lspconfig` to the native diagnostics command. By default it passes an empty language-service config so packages do not need to add the TypeScript plugin stanza just to run CI diagnostics.

## Oxlint Rules

The oxlint JS plugin currently ports these AST-only rules as warnings:

- `effect/unnecessaryPipe`
- `effect/unnecessaryPipeChain`
- `effect/unnecessaryEffectGen`
- `effect/effectMapVoid`
- `effect/effectSucceedWithVoid`
- `effect/schemaStructWithTag`
- `effect/schemaUnionOfLiterals`
- `effect/unnecessaryArrowBlock`
- `effect/globalFetch`
- `effect/processEnv`
- `effect/globalDate`
- `effect/globalConsole`
- `effect/globalRandom`

The native engine still owns type-aware or Effect-context-aware rules such as `missingEffectError`, `missingEffectContext`, `missingLayerContext`, `floatingEffect`, generator-yield correctness, Layer/service checks, and in-Effect global API variants.

## Tradeoffs

Compared with the Effect LSP baseline, this keeps the expensive TypeScript project-service pass separate from oxlint, so it can duplicate some type graph work already done by `vp lint` with `typeCheck`. The upside is correctness: the existing Effect diagnostics run through the compiler APIs they were written for, while oxlint handles only cheap AST checks. A useful benchmark would compare `pnpm lint:effect` against PR #571's per-package `check:effect-lsp` scripts on large packages such as `sheet-apis`, `sheet-web`, and `sheet-workflows`.
