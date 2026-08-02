# Domain Docs

How the engineering skills should consume this repository's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repository root. It points to the `CONTEXT.md` files relevant to each domain.
- **Relevant context documents** listed in `CONTEXT-MAP.md`.
- **`docs/adr/`** for system-wide architectural decisions.
- **Context-specific ADR directories** identified by `CONTEXT-MAP.md`, normally located beside the corresponding context document.

If any of these files do not exist, proceed silently. Do not flag their absence or suggest creating them upfront. The `/domain-modeling` skill creates them lazily when terms or decisions are resolved.

## File structure

This is a multi-context monorepo:

    /
    ├── CONTEXT-MAP.md
    ├── docs/
    │   └── adr/                         ← system-wide decisions
    └── packages/
        └── <context-owning-package>/
            ├── CONTEXT.md
            ├── docs/
            │   └── adr/                 ← context-specific decisions
            └── src/

`CONTEXT-MAP.md` is authoritative for context boundaries. A context may span several packages, so agents must follow the map rather than assuming every package is an independent domain.

## Use the glossary's vocabulary

When output names a domain concept—such as in an issue title, refactor proposal, hypothesis, or test name—use the term defined in the relevant `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If a needed concept is absent, reconsider whether the term belongs to the project or note the gap for `/domain-modeling`.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface it explicitly rather than silently overriding it:

> _Contradicts ADR-0007 (event-sourced orders)—but worth reopening because…_
