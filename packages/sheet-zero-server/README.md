# sheet-zero-server

Server-only Sheet Zero implementation shared in-process by deployable runtimes.

The package binds the canonical `sheet-zero-api` procedures to authorization and database
execution, and exposes a policy-filtered trusted persistence interface for workflow code. It does
not own an HTTP server, router, runtime configuration, raw SQL access, provider actions, or generic
procedure dispatch.

All code entrypoints are blocked from browser resolution.
