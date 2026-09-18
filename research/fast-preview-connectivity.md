# Connectivity and scoped routing for development previews

Research for [TIA-222](https://linear.app/tiara-stack/issue/TIA-222), under [TIA-220](https://linear.app/tiara-stack/issue/TIA-220). Investigated 2026-09-18 against repository commit `0459b7a95a39cee283f608a6e829da02b827ebd4`. This is a planning artifact, not a deployment recipe or a user policy decision. `sheet-formulas` and `vibecord` are excluded.

## Findings

The earlier explicit HTTPS plus deliberate Telepresence connect/ingest direction remains a useful outbound-access baseline. It does not complete selective backend previews. Three separate problems remain: cluster-private access from this restricted development container, routing callbacks back to selected processes, and preserving a preview identity across asynchronous work. Sharing compatible development state does not solve those routing problems.

The strongest candidates for host-native execution are web and request-driven APIs after their origin and dependency contracts are extended. Ordinary and browser workflow runners need a cluster-reachable advertised address and Kubernetes health/discovery integration. The ordinary runner also participates in shared background dispatch. Keeping these roles in Kubernetes with source reload is a credible accommodation, but concurrent runner ownership remains a separate decision.

These are recommendations inferred from the source contracts below. No traffic interception, installation, deployment, secret retrieval, application request, database connection or workflow execution occurred.

## Evidence boundaries

**Repository facts** below refer to the pinned source. **Documented capabilities** refer to current Telepresence 2.31 documentation, not an installed version. **Observed** means the explicitly listed read-only checks succeeded. **Inference** identifies an integration consequence that has not been tested end to end.

The earlier [TIA-177 resolution](https://linear.app/tiara-stack/issue/TIA-177) selected allowlisted development HTTPS origins, deliberate connect/ingest for private dependencies, narrow namespace/RBAC and environment exclusions. [TIA-179](https://linear.app/tiara-stack/issue/TIA-179) deferred full-remote backend execution, required explicit mode selection and forbade automatic local/remote fallback. This report investigates the extension without changing those decisions.

### Observed workspace and development cluster

Read-only commands ran from the agent container on 2026-09-18:

```text
command lookup: kubectl, docker, gt and gh present; telepresence absent
/dev/net/tun: absent
/var/run/docker.sock: absent
/proc/self/status CapEff: 0000000000000000
/proc/self/status Seccomp: 2
default kubeconfig: present; contents not printed
kubectl --request-timeout=10s -n tiara-stack-dev get deployments
kubectl --request-timeout=10s -n tiara-stack-dev get pods
kubectl --request-timeout=10s -n tiara-stack-dev get networkpolicies
```

Only names, ready-replica counts, container names and NetworkPolicy specifications were selected. All seven application Deployments existed. Six reported one ready replica; browser runner had no `readyReplicas` field. This is a point-in-time readiness observation, not a diagnosis. The nine application/dependency pods listed no traffic-agent sidecar. Eleven NetworkPolicies existed and their peers matched the source restrictions described below. A manager outside this namespace or a node-hosted agent was not checked; their absence is not claimed. The cluster API is accessible from this container. Private application connectivity and CNI enforcement were not tested.

Running Telepresence entirely inside a container requires a TUN device and `NET_ADMIN`; IPv6 additionally needs the documented sysctl. This workspace lacks the first two prerequisites. Laptop installation instructions therefore do not work here unchanged. Docker mode creates the connected network in a daemon container, requiring an accessible Docker engine and deliberate placement of application processes in that network. A Docker binary alone proves neither. No remote Docker endpoint was inspected. [Container requirements](https://telepresence.io/docs/howtos/inside-container), [Docker mode](https://telepresence.io/docs/howtos/attach#running-everything-using-docker).

## What the connection mechanisms supply

| Mechanism | Documented behavior | Consequence for this project |
| --- | --- | --- |
| Explicit development HTTPS | Already the Fast web dependency contract | Avoids cluster DNS for exposed HTTP endpoints. Does not expose Redis, Postgres, Meilisearch or runner RPC. |
| Telepresence connect | TUN routes TCP/UDP cluster traffic and resolves selected Kubernetes names | Outbound path; does not make a new workstation listener discoverable by a cluster client. |
| Ingest | Reads a workload's environment and volumes; leaves traffic and remote process alone | Useful only with an approved variable/mount allowlist. Not a callback tunnel or a consumer replacement. |
| Filtered intercept | Sends matching HTTP requests on selected ports to the workstation; remote process continues | Can scope request-driven preview traffic when every caller carries a disjoint routing marker. Background consumers still run remotely. |
| Replace | Removes target container, routes its traffic locally, restores it when attachment ends | Single-owner operation. Cannot meet unrelated-developer isolation on the shared workload. |
| Port-forward | Single-service debugging fallback in TIA-177 | Does not supply general DNS or reverse callbacks; one local port mapping cannot substitute for advertised runner addresses. |

Sources: [launcher configuration](https://github.com/tiara-stack/tiara-stack/blob/0459b7a95a39cee283f608a6e829da02b827ebd4/packages/developer-launcher/src/config.ts), [connection routing](https://telepresence.io/docs/reference/routing), [attachments](https://telepresence.io/docs/concepts/attachments). Connect normally routes through the manager; an attachment must not be assumed to grant the target pod's identity to every outbound connection. Verify the actual manager/agent path and effective source against the selected version and CNI.

## Feasibility matrix

All conditional paths require explicit dev credentials, compatible State Plane contracts and no fallback to a different state environment.

| Direction and dependency | Current contract and supported candidate path | Missing proof or implementation |
| --- | --- | --- |
| Local web to auth, Zero and Workflow API | Explicit allowlisted development HTTPS endpoints already exist in Fast | Browser origin acceptance, OAuth callback registration and WebSocket reconnection must pass for the actual preview URL. Current Fast backend configuration rejects remote dependencies. |
| Local backend to Kubernetes DNS | Connect maps cluster DNS and routes, given a working client and manager | This container needs a networking accommodation; mapped namespaces alone are not an authorization boundary. |
| Local auth/db/workflows to managed Postgres | Helm consumes `postgresUrl` secrets; private TCP can use an explicitly configured cluster route | Endpoint hostname, private subnet, DNS suffix, TLS CA/name, database role and managed-service firewall were not read from secrets. A database outside Service/Pod CIDRs may need `alsoProxy` plus DNS configuration. No direct laptop reachability established. |
| Local auth/bot to Redis | Helm consumes Redis URLs; connect can carry TCP to an allowed target | Actual Redis location, TLS, authentication and network allowlist remain unverified. Do not assume a Kubernetes Service named redis exists. |
| Local backend to auth/JWKS | Public auth HTTPS where permitted; private auth via a proven cluster path | Private auth policy accepts selected application peers, not an arbitrary manager. Kubernetes JWKS/token-review callers additionally need the configured CA, token audience and API permissions. |
| Local workflows to bot capabilities | Bot HTTP service is cluster-private and permits workflow API/runner peers | Prove the tunnel's source is admitted, or design a narrow dev relay/policy. HTTP success still requires the correct OAuth audience and gateway identity. |
| Local web to Meilisearch | Private Meilisearch Service, limited to web/indexer pod peers | Plain manager-origin traffic is not among allowed peers. Need a verified source path, narrow relay or scoped policy, plus search key/index configuration. |
| Local Workflow API/runner to remote runner RPC | Runner address is registered in shared cluster storage; RPC path is `/cluster/rpc`, port 34431 | Must reach registered pod addresses, not just a Service alias. NetworkPolicy allows role-specific peers. Namespace DNS alone is insufficient. |
| Remote Zero Cache to local db-server | Cache fixes `/zero/query` and `/zero/mutate` at the shared db-server Service | Connect/ingest supplies no reverse route. Filtered intercept or an explicit callback proxy/preview cache is needed. Current forwarding allows only `authorization`, so a preview header is lost. |
| Remote cluster to local workflow runner | Runner advertises host/port separately from its listen address; Helm sets advertised host from pod IP | Localhost is unusable remotely. Need a routable session endpoint and health/discovery integration. Shared shard allocation is not scoped by HTTP preview headers. |
| Browser to local web/auth/API | Local listener or authenticated HTTPS workspace exposure | User browser localhost differs from workspace localhost. Vite only adds the existing Hermes host; new hosts and HMR WSS need explicit support. Workflow API accepts one configured web origin. |
| External events to selected bot | Bot has an external gateway connection and capability routes | HTTP intercept does not stop remote gateway consumption or duplicate side effects. Separate test identity or explicit single-owner operation is required; not decided here. |

Code sources: [service roles, secret references and permitted peers](https://github.com/tiara-stack/tiara-stack/blob/0459b7a95a39cee283f608a6e829da02b827ebd4/charts/tiara-stack/templates/_helpers.tpl), [NetworkPolicies](https://github.com/tiara-stack/tiara-stack/blob/0459b7a95a39cee283f608a6e829da02b827ebd4/charts/tiara-stack/templates/networkpolicy.yaml), [Zero callback and header configuration](https://github.com/tiara-stack/tiara-stack/blob/0459b7a95a39cee283f608a6e829da02b827ebd4/charts/tiara-stack/templates/zero-cache-statefulset.yaml), [runner registration, shard storage and health](https://github.com/tiara-stack/tiara-stack/blob/0459b7a95a39cee283f608a6e829da02b827ebd4/packages/sheet-workflows/src/cluster/runtime.ts), [Workflow API CORS](https://github.com/tiara-stack/tiara-stack/blob/0459b7a95a39cee283f608a6e829da02b827ebd4/packages/sheet-workflows/src/http.ts), [Vite host configuration](https://github.com/tiara-stack/tiara-stack/blob/0459b7a95a39cee283f608a6e829da02b827ebd4/packages/sheet-web/vite.config.ts).

## Scope must survive every hop

A disjoint HTTP marker can support multiple developers on a request-driven service. It is not a durable workflow partition or an authentication claim. A browser-selected marker must survive the web server, API clients, Zero callback forwarding and any subsequent RPC hop. The current cache's authorization-only forwarding is a concrete break in that chain. The shared runner tables, shard groups and dispatcher have no preview marker in their routing configuration. Intercepting API ingress does not ensure that later asynchronous work executes on the same developer's runner. [Zero configuration](https://github.com/tiara-stack/tiara-stack/blob/0459b7a95a39cee283f608a6e829da02b827ebd4/charts/tiara-stack/templates/zero-cache-statefulset.yaml), [workflow cluster runtime](https://github.com/tiara-stack/tiara-stack/blob/0459b7a95a39cee283f608a6e829da02b827ebd4/packages/sheet-workflows/src/cluster/runtime.ts).

Recommendation: use explicit session origins and a deliberately propagated marker only for paths whose callers can preserve it. Validate WebSocket upgrade/reconnect routing separately; this investigation did not prove marker propagation through Zero's WebSocket protocol. Do not route on bearer-token contents or treat possession of a preview header as authorization. Keep durable runner selection and gateway ownership as explicit follow-up design questions.

Auth has two independent restrictions: its HTTP CORS configuration and Better Auth trusted origins. Web OAuth client seeding also binds redirect configuration. Merely pointing `AUTH_BASE_URL` at dev does not register a new callback origin. Preserve issuer/audience checks when networking changes, and do not reuse projected Kubernetes tokens by copying whole pod environments. [Auth server](https://github.com/tiara-stack/tiara-stack/blob/0459b7a95a39cee283f608a6e829da02b827ebd4/packages/sheet-auth/src/server.ts), [auth configuration](https://github.com/tiara-stack/tiara-stack/blob/0459b7a95a39cee283f608a6e829da02b827ebd4/packages/sheet-auth/src/auth-config.ts), [OAuth seed job](https://github.com/tiara-stack/tiara-stack/blob/0459b7a95a39cee283f608a6e829da02b827ebd4/charts/tiara-stack/templates/seed-trusted-oauth-clients-job.yaml).

## Permissions, policy and versions

Telepresence's current documentation permits a manager to reject global intercepts and replacements with `intercept.allowGlobalIntercepts=false`, while retaining filtered HTTP intercepts. Attachment setup may inject an agent even for ingest, so ingest is not an infrastructure-read-only operation. Numeric target ports can require a `NET_ADMIN` init container; node-hosted agents are a different cluster privilege choice, not a fix for missing workstation TUN privileges. [Cluster configuration](https://telepresence.io/docs/reference/cluster-config).

A narrow installation needs a static dev namespace selection and audited manager/client roles. Clients require manager discovery and `pods/portforward`; attachment access needs additional workload discovery/agent access. Current static-namespace documentation still lists cluster-wide ServiceCIDR discovery. Do not promise zero cluster-wide permissions without inspecting the pinned chart. Authentication mode and caller authorization must be verified on the installed manager. [RBAC](https://telepresence.io/docs/reference/rbac), [authentication](https://telepresence.io/docs/reference/authentication).

The source project's license is Apache-2.0, and current docs describe header filtering without an enterprise subscription prerequisite. Historical release notes distinguish OSS and Enterprise clients/managers. Pin and verify the exact client, manager, agent images and supported filtering flags before implementation; this is not evidence that an unknown existing installation supports them. [License](https://github.com/telepresenceio/telepresence/blob/release/v2/LICENSE), [release notes](https://telepresence.io/docs/release-notes), [filtering guide](https://telepresence.io/docs/howtos/attach#intercept-your-application).

The observed chart policies isolate ingress by pod/application labels, release labels and selected namespaces. They contain no general Telepresence-manager peer grant. Kubernetes policies combine additively and depend on CNI enforcement; they constrain connections, not user-level preview identity. Therefore a DNS lookup or successful tunnel connection does not establish service authorization. Confirm effective source identity with positive and negative application probes later. [Kubernetes NetworkPolicy semantics](https://kubernetes.io/docs/concepts/services-networking/network-policies/).

## When source reload in Kubernetes helps

Keeping runners in Kubernetes retains pod addresses, K8s health, projected token rotation and browser runtime dependencies. It avoids requiring inbound RPC to the restricted workspace. It does not isolate shared shard ownership or duplicate bot gateway consumers.

Tilt documents incremental file sync followed by commands and full rebuild fallbacks. This is a feasible mechanism class, not a selected tool. TiaraStack's current workloads use a read-only root filesystem and packaged `dist` entrypoints, so copying TypeScript into them would not create a watch loop. A dedicated dev image/volume/watch entrypoint, source-package closure, lockfile rebuild behavior and session-owned workload would be required. Updating the fixed shared release remains a single shared mutation. [Tilt Live Update](https://docs.tilt.dev/live_update_reference.html), [deployment security context](https://github.com/tiara-stack/tiara-stack/blob/0459b7a95a39cee283f608a6e829da02b827ebd4/charts/tiara-stack/templates/deployment.yaml), [runner Dockerfile](https://github.com/tiara-stack/tiara-stack/blob/0459b7a95a39cee283f608a6e829da02b827ebd4/packages/sheet-workflows/Dockerfile), [launcher Kubernetes contract](https://github.com/tiara-stack/tiara-stack/blob/0459b7a95a39cee283f608a6e829da02b827ebd4/docs/development-launcher.md).

## Failure, cleanup and remaining acceptance evidence

The following are proposed acceptance requirements, not completed tests:

1. Preflight actual workspace networking, dev context, namespace, manager version/RBAC, credential allowlists and remote addresses. Fail with the named dependency when unavailable; preserve TIA-179's no-fallback behavior.
2. Probe DNS, TLS and authenticated access separately for Postgres, Redis, JWKS, bot, registered runner pod addresses and Meilisearch. Include a denied-source check for every new policy exception. Do not infer data isolation from connection success.
3. Run two preview sessions and an unmarked control request through every selected HTTP path. Show that markers reach Zero callbacks, and that unrelated developers remain remote. Separately prove HMR/Zero WebSocket reconnects, OAuth callbacks and credentialed CORS.
4. For runners, prove remote-to-local RPC and health visibility before registering a local address in shared storage. Establish where asynchronous work executes and what happens when the session ends. Current browser-runner readiness must be resolved before relying on it as a healthy dependency.
5. Disconnect during an active callback/RPC and terminate the local process. Mark the preview unavailable; do not silently send work to another State Plane. Measure failure detection and recovery rather than promising lossless in-flight requests.
6. End only this session's attachment and temporary proxy/listeners; remove its environment files and mounts, preserve other sessions. Telepresence documents attachment detach and restoration after replacement, and route cleanup when the VIF session ends. It does not establish this launcher's crash-cleanup behavior. Verify stale attachments and agent injection remnants separately. [Attachment lifecycle](https://telepresence.io/docs/concepts/attachments), [route lifecycle](https://telepresence.io/docs/reference/routing).
7. For cluster reload, verify restart after a source change, shared-library change and dependency change, then restore the session-owned workload's declared state. Stopping a sync process does not itself prove that previously copied code was removed.

The investigation can close as a bounded documentation result. No end-to-end bidirectional route is claimed. The unresolved prerequisites are concrete enough for implementation planning: workspace network placement, session callback/origin contract, private-source policy, runner address/health integration and concurrent consumer ownership.
