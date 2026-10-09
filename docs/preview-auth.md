# Session-bound preview authentication

`developer-launcher` now defines an Effect service for the browser-authentication
boundary in `preview-auth.ts`, with HTTPS route handlers in
`preview-auth-http.ts`. It keeps OAuth provider integration and credential
cipher/storage behind required adapters. No adapter is composed by the default
launcher, so the application-auth profile remains unavailable unless an operator
provides fresh setup evidence and the exact session-owned integrations.

Each registration is keyed by session, generation, role and endpoint. Its client
has one callback URL and an approved return URL. A conflicting same-generation
registration fails instead of changing the stored redirect. Authorization uses
random one-time state and an S256 PKCE verifier retained server-side. Callback
consumes state once, checks the active session again, verifies the resulting
principal's issuer and audience against the registration, and stores upstream
tokens through the private token-store adapter.

The browser route issues `__Host-preview-session` and OAuth-state cookies with
`Secure`, `HttpOnly`, `Path=/`, `SameSite=Lax`, and no `Domain`. App proxy
mutations and CORS preflight require the exact preview Origin. Other app proxy
GET requests without Origin are allowed only when `Sec-Fetch-Site` is absent,
`same-origin`, or `none`; `same-site` and `cross-site` are rejected. When Origin
is supplied, app proxy requests require an exact preview-origin match.
Only a positive header list is sent upstream. Browser cookies, Authorization,
forwarding headers, and routing metadata are ignored. Upstream Set-Cookie,
Location, CORS, and authentication headers are never returned. The proxy fixes
the destination to the registered endpoint and refuses token-bearing URL query
keys. It also redacts an exact upstream access-token echo from the response.

The protected request retains the user's user/account identity, scopes, issuer,
audience, and actor provenance in the server-side session record, while using
that user's upstream token for application authorization. The preview
credential is checked against the session, generation, role, endpoint, stored
credential hash and live controller authority. It cannot be retargeted to a
shared endpoint. Token refresh is only attempted after live-session validation;
stop or expiry blocks it. Owner-authorized cleanup requires an ended session and
removes only client registrations whose recorded owner key matches, plus that
session's token copies.

## Local contract evidence

`packages/developer-launcher/src/preview-auth.test.ts` exercises two active
sessions signing in as the same Effective Principal and issuing protected
requests. It checks cross-session credentials, callback state mismatch, a
shared-origin bypass, hostile Origin, stripped parent-domain cookies and
Authorization headers, filtered response cookies, token non-disclosure, stop
fencing, continued access for the other session, and exact cleanup. The HTTP
boundary test checks Secure/HttpOnly host-only cookies and Origin rejection.
These adapter-backed contract tests are not live OAuth or browser evidence. The
generic proxy rejects non-GET methods and `/zero/*`, `/workflows/*`, and
`/internal/rollout-gates/*` before calling its upstream adapter: its lifecycle
check cannot be atomic with application writes, Zero mutation/query acceptance,
or durable workflow enqueue/observation. The generic proxy also rechecks the
session immediately before dispatch after token reads or refresh. That check
fences new ordinary GET dispatches but does not prove acceptance for a request
already in flight.

Still unverified: provider-specific compatible shared-login registration,
real token encryption/storage, deployed callback allowlists, CORS behavior at
the public gateway, server-function data-flow audit, cookie behavior in a real
browser, direct shared URL rejection by every application backend, and Zero/WSS
reauthentication and queued durable-acceptance fencing. There is no WSS route or
transport adapter in this checkout. Mutating application, Zero, workflow, and
rollout-gate traffic remains unavailable through the preview proxy until backend
acceptance adapters can validate trusted session/user/role/generation evidence
at the actual commit or observation boundary. The profile stays unsupported
until those adapters and acceptance checks are supplied.
