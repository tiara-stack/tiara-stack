# TiaraStack Helm Chart

This chart deploys the TiaraStack Kubernetes runtime services and keeps secret
values outside Helm by default.

## Prerequisites

- Kubernetes 1.24+
- Helm 3.8+
- cert-manager when using the production TLS defaults
- Infisical operator when `infisical.enabled=true`
- A StorageClass compatible with the Zero Cache and Meilisearch persistence settings;
  production defaults to `do-block-storage`

## Install

Create the required external Secrets from the [Secret Contract](#secret-contract)
section first, then install:

```sh
helm upgrade --install tiara-stack charts/tiara-stack \
  --namespace tiara-stack-prod \
  --create-namespace \
  --values charts/tiara-stack/values.yaml \
  --values charts/tiara-stack/values-production.yaml \
  --set-string global.appImage.registry=<registry> \
  --set-string global.appImage.tag=<tag>
```

Optionally add your own environment-specific overrides file after
`values-production.yaml` if you need to override the shipped production
defaults.

Set the shared app image registry and tag in `global.appImage`. By default the
chart renders app images as
`<global.appImage.registry>/<service-name>:<global.appImage.tag>`. Per-service
`services.*.image.repository`, `services.*.image.tag`, and
`services.*.image.pullPolicy` values can override the shared defaults.

NetworkPolicies default to allowing public Zero Cache traffic from an ingress
controller in the `ingress-nginx` namespace. Override
`ingress.controllerNamespace` if your controller runs elsewhere. Prometheus
scrape policies default to the `monitoring` namespace; override
`monitoring.prometheusNamespace` if needed.

## Secret Contract

`sheet-auth-secret`

- `baseUrl`
- `cookieDomain` optional
- `postgresUrl`
- `otelExporterOtlpEndpoint`
- `discordClientId`
- `discordClientSecret`
- `redisUrl`
- `trustedOrigins`
- `trustedOAuthClientIds`
- `tokenExchangeSubjectJwtSecret`

`sheet-apis-secret`

- `otelExporterOtlpEndpoint`
- `zeroCacheServer`
- `redisUrl`
- `sheetAuthIssuer`
- `sheetIngressBaseUrl`
- `sheetApisServiceClientId`
- `sheetApisServiceClientSecret`
- `sheetAuthTrustedDelegationClientIds`

`sheet-apis-secret-path`

- `google-service-account.json`

`sheet-bot-secret`

- `otelExporterOtlpEndpoint`
- `discordToken`
- `discordClientId`
- `redisUrl`
- `sheetIngressBaseUrl`
- `sheetAuthIssuer`
- `sheetBotServiceClientId`
- `sheetBotServiceClientSecret`

`sheet-workflows-secret`

- `otelExporterOtlpEndpoint`
- `postgresUrl`
- `sheetAuthIssuer`
- `sheetIngressBaseUrl`
- `sheetWorkflowsServiceClientId`
- `sheetWorkflowsServiceClientSecret`
- `sheetAuthTrustedDelegationClientIds`

`sdbs-secret`

- `postgresUrl`
- `otelExporterOtlpEndpoint`

`sheet-ingress-server-secret`

- `otelExporterOtlpEndpoint`
- `sheetApisBaseUrl`
- `sheetWorkflowsBaseUrl`
- `sheetBotBaseUrl`
- `sheetAuthIssuer`
- `trustedOrigins`
- `sheetIngressServiceClientId`
- `sheetIngressServiceClientSecret`
- `sheetAuthOAuthTokenExchangeClientId` optional
- `sheetAuthOAuthTokenExchangeClientSecret` optional

`sheet-web-secret`

- `otelExporterOtlpEndpoint`
- `authBaseUrl`
- `appBaseUrl`
- `sheetApisBaseUrl`
- `sheetWebOauthClientId` optional
- `sheetWebOauthRedirectPath` optional
- `sheetWebOauthScopes` optional
- `meilisearchSearchApiKey` (search-only key; safe for the public search proxy)

`meilisearch-secret`

- `meilisearchMasterKey` (Meilisearch process secret)
- `meilisearchAdminApiKey` (index-management key used only by indexing jobs)

`zero-secret`

- `nodeEnv`
- `zeroReplicaFile`
- `zeroUpstreamDb`
- `zeroCvrDb`
- `zeroChangeDb`
- `zeroAppPublications`
- `zeroAdminPassword` optional

Production TLS uses a Kubernetes TLS Secret named `theerapakg-moe-tls`. The
Secret must be type `kubernetes.io/tls` with `tls.crt` and `tls.key`, and the
certificate must cover `auth.theerapakg.moe`, `schedule.theerapakg.moe`,
`sheet.theerapakg.moe`, and `zero.theerapakg.moe`.

The default and production values include the cert-manager ingress annotation
`cert-manager.io/cluster-issuer: letsencrypt-prod`, so cert-manager ingress-shim
is expected to own the generated `Certificate` and reconcile
`theerapakg-moe-tls`. Before deploying `values-production.yaml`, make sure the
ClusterIssuer exists. If you instead create `theerapakg-moe-tls` manually, remove
or override `ingress.annotations.cert-manager.io/cluster-issuer`, or disable or
delete the generated `Certificate` resource for that Secret name before applying
the Ingress.

Verify the secret with:

```sh
kubectl -n tiara-stack-prod get secret theerapakg-moe-tls \
  -o jsonpath='{.type}{"\n"}{.data.tls\.crt}{"\n"}'
```

You can create it directly from certificate files with:

```sh
kubectl -n tiara-stack-prod create secret tls theerapakg-moe-tls \
  --cert=fullchain.pem \
  --key=privkey.pem
```

## Scheduling

Use `nodeSelector` and `tolerations` to control where TiaraStack pods run. Set
them globally for all workloads or per-workload to override the default.

```yaml
# Pin every workload to a dedicated node pool.
global:
  nodeSelector:
    workload: tiara-stack
  tolerations:
    - key: dedicated
      operator: Equal
      value: tiara-stack
      effect: NoSchedule

# Override scheduling for just the Zero Cache StatefulSet.
zeroCache:
  nodeSelector:
    workload: zero-cache
  tolerations:
    - key: dedicated
      operator: Equal
      value: zero-cache
      effect: NoSchedule

# Override scheduling for a single service Deployment.
services:
  sheetBot:
    nodeSelector:
      workload: sheet-bot
    tolerations:
      - key: dedicated
        operator: Equal
        value: sheet-bot
        effect: NoSchedule
```

The `seed-trusted-oauth-clients` Job inherits the `services.sheetAuth`
scheduling values and can be overridden further through
`services.sheetAuth.seedTrustedOAuthClients.nodeSelector` and
`services.sheetAuth.seedTrustedOAuthClients.tolerations`.

The precedence order is: per-workload > parent service (`sheetAuth` for the seed
job) > global.

Because the templates use `coalesce`, an empty `nodeSelector: {}` or
`tolerations: []` at a lower level is treated as unset and will fall through to
the parent service or global values. You cannot use an empty value to explicitly
clear inherited scheduling constraints for a single workload.

The default `values.yaml` sets `nodeSelector: {}` and `tolerations: []` on every
workload, so omitting these fields leaves pods unconstrained.

## Infisical Operator

The chart can optionally render Infisical operator resources that reconcile the
same Kubernetes Secret names listed above. This keeps the application
Deployments unchanged: they still read ordinary Kubernetes Secrets, while
Infisical becomes the source of truth.

Install and operate the Infisical secrets operator separately from this
application repo. Create an Infisical machine identity with project access,
then configure either:

- Kubernetes auth: create `tiara-stack-infisical-identity` with an `identityId`
  key and enable Kubernetes auth for the service account
  `tiara-stack-infisical-auth` in the app namespace.
- Universal auth: create `tiara-stack-infisical-universal-auth` with `clientId`
  and `clientSecret`, then set `infisical.auth.method=universal`.

Enable chart-managed Infisical syncs by setting:

```yaml
infisical:
  enabled: true
  projectId: "<infisical-project-id>"
  environmentSlug: prod
  secretPathPrefix: /tiara-stack
  connection:
    address: https://infisical.theerapakg.moe
```

When `infisical.auth.create=true`, the chart creates an `InfisicalAuth` named
by `infisical.auth.name` (default `tiara-stack-infisical`). When
`infisical.managedSecrets.create=true`, every generated `InfisicalStaticSecret`
references that same `infisical.auth.name`. If you pre-create your own
`InfisicalAuth`, set `infisical.auth.create=false` and set
`infisical.auth.name` to that resource name.

The default Infisical paths are:

- `/tiara-stack/sheet-auth-secret`
- `/tiara-stack/sheet-apis-secret`
- `/tiara-stack/sheet-apis-secret-path`
- `/tiara-stack/sheet-bot-secret`
- `/tiara-stack/sheet-workflows-secret`
- `/tiara-stack/sdbs-secret`
- `/tiara-stack/sheet-ingress-server-secret`
- `/tiara-stack/sheet-web-secret`
- `/tiara-stack/zero-secret`
- `/tiara-stack/meilisearch-secret`

**Important:** each path must contain keys matching the Kubernetes Secret keys
exactly, including case; the chart does not transform or normalize key names.
For example, `/tiara-stack/sheet-web-secret` must contain `authBaseUrl`, not
`authbaseurl` or `auth_base_url`, to populate the Kubernetes Secret key
`authBaseUrl`.

## Optional CA Certificate

Set `global.caCertificate.enabled=true` to mount a CA certificate at
`/usr/local/share/ca-certificates/tiarastack` for every application pod.

Use `global.caCertificate.existingConfigMap` to reference a pre-created
ConfigMap, or provide `global.caCertificate.value` to have the chart render one
shared ConfigMap named `<fullname>-ca-certificate`, where `<fullname>` is
derived from the chart fullname helper.

Production values reference an existing ConfigMap named
`tiara-stack-ca-certificate`. Create it in the release namespace before install:

```sh
kubectl -n tiara-stack-prod create configmap tiara-stack-ca-certificate \
  --from-file=ca-certificate.crt=./ca-certificate.crt
```

## Zero Cache Persistence

`zeroCache.persistence.storageClassName` defaults to an empty string so the
cluster default StorageClass is used. Production overrides currently set
`do-block-storage`.

The `zeroReplicaFile` secret value must point under a writable mount because the
container root filesystem is read-only. The default `/data/zero.db` works
because `zeroCache.persistence.enabled=true` mounts a persistent volume at
`/data`. If using a custom path, ensure it is under a writable volume mount.
If the path is invalid or not writable, the Zero Cache container will fail with
database open/write, permission denied, or read-only filesystem errors and the
pod may restart. Check the Zero Cache logs and pod events, then use the default
`/data/zero.db`, enable persistence, or point `zeroReplicaFile` at another
writable mounted volume with suitable ownership.

## Meilisearch docs search

Meilisearch runs as a dedicated, single-replica StatefulSet. It is not a
sidecar: this lets the public SheetWeb runtime and short-lived indexing jobs use
the same durable index without coupling search restarts to either workload.
The service is cluster-internal and its NetworkPolicy accepts traffic only from
SheetWeb and the docs indexer.

Persistence follows the Zero Cache convention. The default 5 GiB RWO claim is
retained when the StatefulSet is deleted. Production uses `do-block-storage`;
set `meilisearch.persistence.existingVolumeName` to bind a pre-created retained
volume. The deployment workflow accepts this as the
`MEILISEARCH_EXISTING_VOLUME_NAME` repository variable.

All three keys stay in Infisical. The master and admin/indexer keys live under
`/tiara-stack/meilisearch-secret`; the search-only key lives under
`/tiara-stack/sheet-web-secret`. Never pass the master or admin key to SheetWeb
or browser code.

On first install, Helm runs the index job as a bootstrap/fallback hook. After
each successful app deployment, CI renders the same job without hook metadata
and performs the primary incremental sync from the manifest bundled in the
SheetWeb image. Use `meilisearch.indexingJob.mode=full` for a manual atomic
rebuild when recovering an index.
