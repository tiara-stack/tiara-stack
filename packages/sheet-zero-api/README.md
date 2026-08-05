# sheet-zero-api

Browser-safe, sheet-specific Rocicorp Zero application contracts and clients.

The package root exposes the replicated schema, public procedure registries, public function
references, replicated row codecs, and the application client constructor. Trusted registries,
service clients, internal references, and workflow transaction helpers are available only from
`sheet-zero-api/server`, which is blocked in browser resolution.

The generated Zero schema is derived from the canonical PostgreSQL schema in `sheet-db-schema`.
`sheet-zero-api` has no runtime dependency on that persistence package; parity is enforced by the
database-schema test suite.
