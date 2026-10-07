# Session preview gateway

TIA-237 adds the gateway route and owner-grant protocol to `developer-launcher`.
It serves disposable probes only. Connected application routes remain unsupported.
The default CLI does not start a gateway or infer authentication, DNS, certificate,
or relay identity evidence from configuration.

The binding decisions are [TIA-230](https://linear.app/tiara-stack/issue/TIA-230),
[TIA-224](https://linear.app/tiara-stack/issue/TIA-224), and
[TIA-227](https://linear.app/tiara-stack/issue/TIA-227). This implementation does
not authorize deployment, credential changes, or access to production.

## Route and grant contract

`makePreviewGateway` uses the existing session controller and its SQLite store.
The allocator must have recorded owned service and attachment receipts from
TIA-236 in that same store. No separate in-memory route authority replaces them.

Each route has the hostname `p-<session UUID>-<role>.<development domain>`. It maps
to exactly one relay FQDN, service resource ID, attachment resource ID, application
port, process, source revision, state group, and session generation. The session
must declare the role and state group. Both relay receipts must match the session,
role, process and recorded allocation-owner digest. Quarantined or missing
allocations do not admit traffic.

The private `dispatchPreviewGatewayProtocol` accepts these versioned-shape
messages with `version: 1`, validated with Effect Schema:

| Message         | Required fields                                  | Result                              |
| --------------- | ------------------------------------------------ | ----------------------------------- |
| `RegisterProbe` | `target`, `ownerIdentity`                        | Recorded hostname and exact target  |
| `Grant`         | `hostname`, `ownerIdentity`, `userId`, `allowed` | Grant added or removed              |
| `Cleanup`       | `hostname`, `ownerIdentity`                      | Route tombstoned and grants removed |

Expose this dispatcher only through the controller's authenticated private
administration boundary. It is not mounted on the public HTTPS listener. Owner
proof is the private identity returned by the existing session controller, not
a user ID from a request header. Do not log it or place it in a public URL.
Additional-user config declarations do not install grants by themselves.

Registration verifies the target through a newly authenticated adapter connection
before recording the route. It can run while the session is pending. Admission
requires the active session and active revision as well. Re-registering the same
target is idempotent; retargeting within a generation is rejected. Explicit resume
requires fresh target verification and the controller's new generation. It drops
old grants, and old browser proofs cannot adopt the new generation. Removed routes
and ended sessions cannot be resurrected.

Gateway authentication is independent of `sheet-auth` and of selected application
health. Its verified principal includes user, session, role, generation and an
expiry. Only the owner or a user granted on that exact route is admitted. This
identity confers no application authorization.

## Public probe transport

`PreviewGatewayHttpsLive` binds an Effect HTTP router through Node's TLS server.
Only `GET /_preview/probe` is mounted, for HTTPS requests and WebSocket upgrades.
Query parameters, WebSocket subprotocol credentials and cross-origin requests
are rejected. A WebSocket upgrade requires the exact HTTPS Origin. A top-level
HTTP navigation may omit Origin. Unknown hosts have no default upstream.

The relay receives only the allowlisted `Accept` and `Accept-Language` headers.
The gateway removes cookies, Authorization, forwarding headers and arbitrary
routing metadata. The probe response is plain text with `Cache-Control: no-store`;
upstream cookies, redirects and authentication headers are not propagated.
WebSocket handshake credentials are not forwarded to the relay.

The transport adapter authenticates the actual relay and attests the full target
on the connection used for forwarding. Echoing client headers, trusting selected
application code to identify itself, or checking a different health connection
is insufficient. The adapter must verify its service/attachment identities and
port against operator-owned provider observations. The disposable-probe assertion
must also be verified; renaming an application a probe is not supported.

Every HTTP operation and each WebSocket frame in either direction rechecks the
session, user grant, generation, revision, owned receipts and connection state.
Reconnect authenticates again against the same hostname and target. No shared
service or second session is a fallback. The probe HTTP response is buffered;
arbitrary HTTP response streaming, application HMR and application paths are not
advertised by this slice.

Readiness reports `gateway: ready`, `relay: ready`, and
`application: unsupported` separately. Neither route registration nor this report
activates an application in the common launcher lifecycle.

## Stop, expiry and cleanup

The embedded controller publishes scoped transport fences at stop, expiry and
resume. Stop interrupts in-flight probe operations and closes WebSockets. Grant
revocation closes that user's streams. Each connection also has a deadline
watchdog independent of authority polling. A stalled authority check cannot keep
it open past the last verified session lease or user-proof expiry. Fresh authority
checks can observe a renewed session lease; they cannot renew it themselves.

Idle connections check authority/attachment health at most every 100 ms while the
process is scheduled. Authority or connection failure fences them. Each frame
still needs a fresh successful check. Network operations do not hold a database
transaction and cannot prevent the controller from recording stop. Probe traffic
has no durable application effects. The race between application submission and
durable acceptance remains an application-mediation gate for TIA-238 and later
slices.

`cleanupSession(sessionId, ownerIdentity)` removes only recorded routes for that
ended session and retains tombstones. It refuses live sessions, wrong owner proof
and unreadable ownership. Retrying is safe. It leaves the other sessions, shared
control, wildcard DNS, certificate and operator infrastructure intact.

The common `preview cleanup` and `preview resolve` path invokes gateway cleanup
before owned-relay teardown. The CLI constructs a cleanup-only gateway service
for those actions, so cleanup does not need browser authentication or working
relay adapters. Failure to verify route cleanup blocks downstream cleanup and is
reported as failure. It does not bypass the allocator's settlement, ownership or
quarantine rules. Operator automation can use the same method after authoritative
lease expiry; failed cleanup retains the route record for retry.

## Operator deployment and setup

No live adapter implementation, standalone deployment image, or public browser
identity provider is supplied here. Do not deploy an unauthenticated proxy in
its place. Implement and verify these adapters before enabling even the public
probe profile:

1. Provide the existing controller/allocator store to `makePreviewGateway`, and
   run one embedded authority with the gateway. All stop/resume commands must reach
   that same authority. The current local CLI's separate-process controller is
   **not** a verified remote revocation transport. Multiple replicas, multiple
   independent controllers and remote fence delivery remain unsupported.
2. Provision a dedicated development gateway workload, namespace and service
   account. Mount only its private controller database and gateway TLS/identity
   material. Selected host runtimes must not receive controller administration
   credentials. Bind `PreviewGatewayHttpsLive` with an operator-managed certificate
   and private key. Keep its private control protocol off the public listener.
3. Install wildcard DNS for `*.<development domain>` pointing only to this gateway,
   and a certificate covering those single-label session/role names. Configure
   the ingress or load balancer for TLS and WebSocket upgrades without a shared
   default backend. Preserve the original Host; never select a target from
   `Forwarded` or `X-Forwarded-*`. Do not add a plaintext public listener.
4. Implement `checkSetup` with fresh operator observations of the exact domain,
   wildcard DNS/certificate coverage, independent gateway authentication and
   single-controller fence delivery. Observations older than 60 seconds or from
   the future are rejected. A file containing `true` values is not live evidence.
5. Implement `authenticate` with independently verified gateway browser proofs.
   Bind each proof to the session, role, generation, user and expiry. Use host-only
   Secure/HttpOnly credentials and an authenticated acquisition flow. Do not
   accept user/session headers, borrow selected-auth cookies, or distribute
   reusable shared tokens. This slice has no login/cookie-issuance adapter.
6. Implement `connect` over an authenticated, scoped TIA-236 relay path. Attest the
   disposable process, revision and group on that exact connection. Implement
   connection health, HTTP probe, WebSocket and idempotent close operations with
   Effect scopes and interruption. A disconnected relay must return unavailable.
   Setup, authentication and connection/identity operations have five-second
   limits; a deadline watchdog still bounds established authority.
7. Permit ingress only from the actual gateway to the approved preview relays.
   Constrain egress to the controller, independent gateway identity provider,
   required DNS and exact development relay destinations. Preserve TIA-236's
   pinned Telepresence authorization and CNI checks. Do not grant access to shared
   workload attachment, secrets or production networks.
8. Register two disposable probe sessions through the private owner protocol.
   Activate only after target verification. Complete the live acceptance below,
   record its environment and adapter versions, and only then advertise the
   public probe profile. Keep all application profiles unavailable.

This is an operator handoff, not a record that setup has happened. Missing adapters
return `unsupported`/unavailable. The normal preview plan and doctor retain the
unverified routes/identity admission requirement.

## Acceptance evidence and remaining gates

TIA-238 adds the session-bound browser auth adapter and route contract in
[`preview-auth.md`](preview-auth.md). The default launcher does not provide the
operator OAuth/token-store adapters, so application authentication remains
unsupported. The local contract harness does not enable Zero/WSS, workflow
traffic, deployed OAuth registrations or public browser access.

The local evidence is `packages/developer-launcher/src/preview-gateway.test.ts`.
It uses the real SQLite controller, recorded test allocation receipts, Effect HTTP
handlers, paired test sockets and a persisted shared-control row. These are local
contract tests, not public browser, Kubernetes or TLS integration results.

| Scenario                                                                     | Local evidence                                 | Live status |
| ---------------------------------------------------------------------------- | ---------------------------------------------- | ----------- |
| Owner HTTPS probe and two explicit targets                                   | HTTP handler and forwarding assertions         | Not run     |
| Owner grant, denied guest/cross-session proof, revocation                    | Durable grants and established admission tests | Not run     |
| WebSocket upgrade and both frame directions                                  | Handler with scoped Socket adapters            | Not run     |
| Same-session reconnect and stale-generation rejection                        | Reauthentication and explicit resume tests     | Not run     |
| Stop with established/in-flight traffic                                      | Controller fences and interruption tests       | Not run     |
| Idle/in-flight expiry; renewed second session                                | Test clock at recorded lease deadline          | Not run     |
| Unknown/disconnected/wrong process, revision, group, role or resource        | Denial with no forwarding                      | Not run     |
| Authority/setup unavailable; expired user proof                              | Fail-closed checks                             | Not run     |
| Restart, exact cleanup and unchanged shared control                          | SQL persistence and ownership assertions       | Not run     |
| Public browser DNS, certificate, independent login and real relay            | No local substitute                            | Not run     |
| Application credentials, cookies, Zero refresh/replay and durable acceptance | Explicitly unsupported                         | Not run     |

For live acceptance, capture the two session/role URLs, recorded relay/process
identities, owners, explicit user grants, lease deadlines and adapter versions.
From an external browser, prove owner HTTP/WSS access and denied ungranted access;
then grant and revoke a second user. Maintain a stream on each session and verify
stop and expiry close only the affected session, reject reconnect and queued
frames, and preserve the other session and separately authenticated shared
control. Compare the shared control's routes, application state and independent
login before and after exact cleanup. Redact proofs, cookies and tokens from the
record. An unrun row does not pass acceptance.

## Implementation validation

Implementation base: `8192335cf6eceebd17bfa37861532ab271d7ad2f`.
Validation on 2026-10-03 used Node 24.18.0 and pnpm 11.1.1.

- `pnpm --filter developer-launcher exec vp test run src/preview-gateway.test.ts src/connected-preview.test.ts src/preview-sessions.test.ts src/preview-session-http.test.ts src/preview-workload-credentials.test.ts src/cli.test.ts src/preview-relay-provider.test.ts`: 158 tests passed in seven files.
- After making fence notifications concurrent, the gateway and session test files
  passed again, 20 tests including the 12 gateway cases.
- `pnpm --filter developer-launcher build`: passed.
- `pnpm exec tsgo -b packages/developer-launcher --pretty false`: passed.
- `pnpm --filter developer-launcher lint` and
  `pnpm --filter developer-launcher format`: passed.
- The required `pnpm check:tsc-build` was attempted before lint. It failed on
  missing workspace build exports, including `effect-zero-workflow/contract/*`,
  `sheet-domain` and `effect-sql-schema/snapshot`, with downstream type errors.
  Only the launcher's dependency builds were prepared for that initial run.
  The coordinator later granted prerequisite builds and a workspace TypeScript retry,
  recorded below.

No final full workspace suite, code-review workflow, rebase, push, PR operation,
hosted review, live deployment or credential change was performed in this phase.

### Coordinator validation follow-up

The follow-up started with a clean worktree at
`ef7af4f9ece16523dc6cbfdaab74f3c71b59e38a`; no uncommitted post-handoff changes
were present. The newly requested Fallow audit found four validation-function
complexity findings and a duplicated TLS server setup block. Named ownership,
session, route-replacement and Origin checks now make those decisions explicit.
The controller and gateway share a TLS-only server layer. Existing admission and
fencing tests verify the refactor; no live profile was enabled.

- `pnpm --filter developer-launcher exec vp test run src/preview-gateway.test.ts src/preview-sessions.test.ts src/connected-preview.test.ts src/cli.test.ts src/preview-session-http.test.ts`:
  114 tests passed in five files after the refactor.
- `pnpm --filter developer-launcher build` and
  `pnpm exec tsgo -b packages/developer-launcher --pretty false`: passed.
- `pnpm dlx fallow@3.31.0 audit --changed-since 8192335cf6eceebd17bfa37861532ab271d7ad2f --format json`:
  initial exit 1; final exit 0, verdict `pass`, with no dead-code, complexity or
  duplication findings. No baseline or suppression was added.
- `pnpm --filter 'effect-zero-workflow...' --filter sheet-domain --workspace-concurrency=1 build`:
  passed. This serially prepared the missing generated entry points and their
  dependencies before retrying workspace TypeScript.
- `pnpm check:tsc-build`: retry passed with exit 0 after the serial prerequisite
  builds. The initial missing-export failure is resolved.
- `pnpm --filter developer-launcher lint` and
  `pnpm --filter developer-launcher format`: passed after the refactor.
