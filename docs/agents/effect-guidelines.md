# Effect and library usage

Use the catalog versions declared by the workspace manifests. These rules
capture project conventions that package configuration does not express.

## Effect

- Use Effect/Schema for runtime validation unless the surrounding code already uses another validation library.
- Do not erase Effect or Layer environment requirements with casts such as `as never` or `as Effect.Effect<..., ..., never>`. Let missing services surface at compile time; keep any necessary adapter cast local.
- Use `Predicate` for reusable predicates and type guards. Prefer `Predicate.isTagged`, `Predicate.hasProperty`, primitive predicates, and combinators over handwritten checks.
- Use `Match` for tagged-union or structured value dispatch. Use typed lookup tables for simple enum or string mappings. Keep imperative branching for genuinely stateful algorithms and early exits.
- Use Effect HTTP client APIs for outbound requests. Prefer `HttpClientResponse.filterStatusOk` and response decoding helpers over manual status checks.
