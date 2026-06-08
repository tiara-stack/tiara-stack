{{- define "tiara-stack.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "tiara-stack.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "tiara-stack.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "tiara-stack.labels" -}}
app.kubernetes.io/name: {{ include "tiara-stack.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "tiara-stack.selectorLabels" -}}
app: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}

{{- define "tiara-stack.image" -}}
{{- $registry := trimSuffix "/" (default "" .root.Values.global.appImage.registry) -}}
{{- $image := .image | default dict -}}
{{- $imageRepository := default .name $image.repository -}}
{{- $repository := $imageRepository -}}
{{- if $registry -}}
{{- $firstPathPart := first (splitList "/" $imageRepository) -}}
{{- if not (or (contains "." $firstPathPart) (contains ":" $firstPathPart) (eq $firstPathPart "localhost")) -}}
{{- $repository = printf "%s/%s" $registry $imageRepository -}}
{{- end -}}
{{- else if not $image.repository -}}
{{- fail (printf "image repository must be set for %s via services.*.image.repository or global.appImage.registry" .name) -}}
{{- end -}}
{{- $tag := default .root.Values.global.appImage.tag $image.tag -}}
{{- if or (not $tag) (eq $tag "0.0.0") -}}
{{- fail (printf "image tag must be set for %s via services.*.image.tag or global.appImage.tag" .name) -}}
{{- end -}}
{{- printf "%s:%s" $repository $tag -}}
{{- end -}}

{{- define "tiara-stack.imagePullPolicy" -}}
{{- $image := .image | default dict -}}
{{- default (default "IfNotPresent" .root.Values.global.appImage.pullPolicy) $image.pullPolicy -}}
{{- end -}}

{{- define "tiara-stack.zeroCacheName" -}}
{{- default "zero-cache" .Values.zeroCache.nameOverride -}}
{{- end -}}

{{- define "tiara-stack.sheetWorkflowsName" -}}
{{- default "sheet-workflows" .Values.services.sheetWorkflows.nameOverride -}}
{{- end -}}

{{- define "tiara-stack.sheetApisName" -}}
{{- default "sheet-apis" .Values.services.sheetApis.nameOverride -}}
{{- end -}}

{{- define "tiara-stack.sheetDbServerName" -}}
{{- default "sheet-db-server" .Values.services.sheetDbServer.nameOverride -}}
{{- end -}}

{{- define "tiara-stack.zeroCacheServiceName" -}}
{{- default "zero-cache-service" .Values.zeroCache.serviceNameOverride -}}
{{- end -}}

{{- define "tiara-stack.zeroCacheHeadlessServiceName" -}}
{{- printf "%s-headless" (include "tiara-stack.zeroCacheName" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "tiara-stack.zeroCacheEnvoyConfigName" -}}
{{- default "zero-cache-envoy-config" .Values.zeroCache.envoy.configMapNameOverride -}}
{{- end -}}

{{- define "tiara-stack.sheetDbServerServiceName" -}}
{{- default "sheet-db-server-service" .Values.services.sheetDbServer.serviceNameOverride -}}
{{- end -}}

{{- define "tiara-stack.caConfigMapName" -}}
{{- if .root.Values.global.caCertificate.existingConfigMap -}}
{{- .root.Values.global.caCertificate.existingConfigMap -}}
{{- else -}}
{{- printf "%s-ca-certificate" (include "tiara-stack.fullname" .root) -}}
{{- end -}}
{{- end -}}

{{- define "tiara-stack.ingressName" -}}
{{- default (printf "%s-ingress" (include "tiara-stack.fullname" .)) .Values.ingress.name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "tiara-stack.imagePullSecrets" -}}
{{- with . }}
imagePullSecrets:
  {{- range . }}
  - name: {{ if kindIs "string" . }}{{ . }}{{ else }}{{ required "global.imagePullSecrets entries must set name" .name }}{{ end }}
  {{- end }}
{{- end }}
{{- end -}}

{{- define "tiara-stack.metricsIngressRule" -}}
{{- if and .root.Values.monitoring.serviceMonitor.enabled (dig "serviceMonitor" "enabled" false .serviceValues) }}
{{- $prometheusNamespace := default .root.Release.Namespace .root.Values.monitoring.prometheusNamespace }}
- from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: {{ $prometheusNamespace }}
  ports:
    - protocol: TCP
      port: {{ .svc.metricPortName }}
{{- end }}
{{- end -}}

{{- define "tiara-stack.defaultSecretName" -}}
{{- $names := dict
  "sheetAuth" "sheet-auth-secret"
  "sheetApis" "sheet-apis-secret"
  "sheetApisGoogleServiceAccount" "sheet-apis-secret-path"
  "sheetBot" "sheet-bot-secret"
  "sheetWorkflows" "sheet-workflows-secret"
  "sheetDbServer" "sdbs-secret"
  "sheetIngressServer" "sheet-ingress-server-secret"
  "sheetWeb" "sheet-web-secret"
  "zeroCache" "zero-secret"
-}}
{{- required (printf "unknown default secret key %s" .) (index $names .) -}}
{{- end -}}

{{- define "tiara-stack.serviceSpecs" -}}
- key: sheetAuth
  name: sheet-auth
  portName: sheet-auth-svc
  metricPortName: sheet-auth-met
  secretName: sheet-auth-secret
  servicePorts:
    - name: sheet-auth-svc
      port: 80
      targetPort: sheet-auth-svc
    - name: sheet-auth-met
      port: 9464
      targetPort: sheet-auth-met
  containerPorts:
    - name: sheet-auth-svc
      containerPort: 3000
    - name: sheet-auth-met
      containerPort: 9464
  env:
    - name: BASE_URL
      secretKey: baseUrl
    - name: COOKIE_DOMAIN
      secretKey: cookieDomain
      optional: true
    - name: POSTGRES_URL
      secretKey: postgresUrl
    - name: OTEL_EXPORTER_OTLP_ENDPOINT
      secretKey: otelExporterOtlpEndpoint
    - name: DISCORD_CLIENT_ID
      secretKey: discordClientId
    - name: DISCORD_CLIENT_SECRET
      secretKey: discordClientSecret
    - name: KUBERNETES_AUDIENCE
      secretKey: kubernetesAudience
      optional: true
    - name: REDIS_URL
      secretKey: redisUrl
    - name: REDIS_BASE
      value: "auth:"
    - name: TRUSTED_ORIGINS
      secretKey: trustedOrigins
    - name: SERVICE_ACCOUNT_JWKS_AUTH_TOKEN_PATH
      value: /var/run/secrets/tokens/kubernetes-jwks-token
  projectedTokens:
    - path: kubernetes-jwks-token
  networkPolicyFrom:
    - app: sheet-apis
      port: sheet-auth-svc
    - app: sheet-bot
      port: sheet-auth-svc
    - app: sheet-workflows
      port: sheet-auth-svc
    - app: sheet-ingress-server
      port: sheet-auth-svc
- key: sheetApis
  name: sheet-apis
  portName: sheet-apis-svc
  metricPortName: sheet-apis-met
  secretName: sheet-apis-secret
  servicePorts:
    - name: sheet-apis-svc
      port: 80
      targetPort: sheet-apis-svc
    - name: sheet-apis-met
      port: 9464
      targetPort: sheet-apis-met
  containerPorts:
    - name: sheet-apis-svc
      containerPort: 3000
    - name: sheet-apis-met
      containerPort: 9464
  env:
    - name: POD_NAME
      fieldPath: metadata.name
    - name: POD_NAMESPACE
      fieldPath: metadata.namespace
    - name: SHEET_INGRESS_NAMESPACE
      fieldPath: metadata.namespace
    - name: OTEL_EXPORTER_OTLP_ENDPOINT
      secretKey: otelExporterOtlpEndpoint
    - name: ZERO_CACHE_SERVER
      secretKey: zeroCacheServer
    - name: ZERO_CACHE_USER_ID
      value: "system:serviceaccount:$(POD_NAMESPACE):sheet-apis"
    - name: REDIS_URL
      secretKey: redisUrl
    - name: SHEET_AUTH_ISSUER
      secretKey: sheetAuthIssuer
    - name: SHEET_INGRESS_KUBERNETES_AUDIENCE
      value: sheet-apis
    - name: SHEET_INGRESS_BASE_URL
      secretKey: sheetIngressBaseUrl
    - name: SERVICE_ACCOUNT_JWKS_AUTH_TOKEN_PATH
      value: /var/run/secrets/tokens/kubernetes-jwks-token
  projectedTokens:
    - path: kubernetes-jwks-token
    - path: zero-cache-token
      audience: zero-cache
    - path: sheet-auth-token
      audience: sheet-auth
  googleServiceAccount: true
  networkPolicyFrom:
    - app: sheet-ingress-server
      port: sheet-apis-svc
- key: sheetBot
  name: sheet-bot
  portName: sheet-bot-svc
  metricPortName: sheet-bot-met
  secretName: sheet-bot-secret
  servicePorts:
    - name: sheet-bot-svc
      port: 80
      targetPort: sheet-bot-svc
    - name: sheet-bot-met
      port: 9464
      targetPort: sheet-bot-met
  containerPorts:
    - name: sheet-bot-svc
      containerPort: 3000
    - name: sheet-bot-met
      containerPort: 9464
  env:
    - name: POD_NAMESPACE
      fieldPath: metadata.namespace
    - name: OTEL_EXPORTER_OTLP_ENDPOINT
      secretKey: otelExporterOtlpEndpoint
    - name: DISCORD_TOKEN
      secretKey: discordToken
    - name: DISCORD_CLIENT_ID
      secretKey: discordClientId
    - name: REDIS_URL
      secretKey: redisUrl
    - name: SHEET_INGRESS_BASE_URL
      secretKey: sheetIngressBaseUrl
    - name: SHEET_AUTH_ISSUER
      secretKey: sheetAuthIssuer
    - name: SHEET_INGRESS_KUBERNETES_AUDIENCE
      value: sheet-bot
    - name: SERVICE_ACCOUNT_JWKS_AUTH_TOKEN_PATH
      value: /var/run/secrets/tokens/kubernetes-jwks-token
  projectedTokens:
    - path: kubernetes-jwks-token
    - path: sheet-auth-token
      audience: sheet-auth
  networkPolicyFrom:
    - app: sheet-ingress-server
      port: sheet-bot-svc
- key: sheetWorkflows
  name: sheet-workflows
  portName: workflows-svc
  metricPortName: workflows-met
  secretName: sheet-workflows-secret
  servicePorts:
    - name: workflows-svc
      port: 80
      targetPort: workflows-svc
    - name: workflows-met
      port: 9464
      targetPort: workflows-met
  extraServices:
    - name: sheet-workflows-runner
      headless: true
      ports:
        - name: workflows-rpc
          port: 34431
          targetPort: workflows-rpc
  containerPorts:
    - name: workflows-svc
      containerPort: 3000
    - name: workflows-rpc
      containerPort: 34431
    - name: workflows-met
      containerPort: 9464
  env:
    - name: POD_NAMESPACE
      fieldPath: metadata.namespace
    - name: OTEL_EXPORTER_OTLP_ENDPOINT
      secretKey: otelExporterOtlpEndpoint
    - name: POSTGRES_URL
      secretKey: postgresUrl
    - name: WORKFLOWS_RUNNER_HOST
      fieldPath: status.podIP
    - name: WORKFLOWS_RUNNER_PORT
      value: "34431"
    - name: WORKFLOWS_RUNNER_LISTEN_HOST
      value: "0.0.0.0"
    - name: WORKFLOWS_RUNNER_LISTEN_PORT
      value: "34431"
    - name: SHEET_AUTH_ISSUER
      secretKey: sheetAuthIssuer
    - name: SHEET_INGRESS_KUBERNETES_AUDIENCE
      value: sheet-workflows
    - name: SHEET_INGRESS_BASE_URL
      secretKey: sheetIngressBaseUrl
    - name: SERVICE_ACCOUNT_JWKS_AUTH_TOKEN_PATH
      value: /var/run/secrets/tokens/kubernetes-jwks-token
  projectedTokens:
    - path: kubernetes-jwks-token
    - path: sheet-auth-token
      audience: sheet-auth
  networkPolicyFrom:
    - app: sheet-ingress-server
      port: workflows-svc
  networkPolicySelf:
    - port: workflows-rpc
- key: sheetDbServer
  name: sheet-db-server
  portName: sdbs-svc
  metricPortName: sdbs-met
  secretName: sdbs-secret
  servicePorts:
    - name: sdbs-svc
      port: 80
      targetPort: sdbs-svc
    - name: sdbs-met
      port: 9464
      targetPort: sdbs-met
  containerPorts:
    - name: sdbs-svc
      containerPort: 3000
    - name: sdbs-met
      containerPort: 9464
  env:
    - name: POSTGRES_URL
      secretKey: postgresUrl
    - name: OTEL_EXPORTER_OTLP_ENDPOINT
      secretKey: otelExporterOtlpEndpoint
  networkPolicyFrom:
    - app: sheet-apis
      port: sdbs-svc
    - app: sheet-ingress-server
      port: sdbs-svc
- key: sheetIngressServer
  name: sheet-ingress-server
  portName: ingress-svc
  metricPortName: ingress-met
  secretName: sheet-ingress-server-secret
  maxUnavailable: 0
  servicePorts:
    - name: ingress-svc
      port: 80
      targetPort: ingress-svc
    - name: ingress-met
      port: 9464
      targetPort: ingress-met
  containerPorts:
    - name: ingress-svc
      containerPort: 3000
    - name: ingress-met
      containerPort: 9464
  env:
    - name: OTEL_EXPORTER_OTLP_ENDPOINT
      secretKey: otelExporterOtlpEndpoint
    - name: SHEET_APIS_BASE_URL
      secretKey: sheetApisBaseUrl
    - name: SHEET_WORKFLOWS_BASE_URL
      secretKey: sheetWorkflowsBaseUrl
    - name: SHEET_BOT_BASE_URL
      secretKey: sheetBotBaseUrl
    - name: SHEET_AUTH_ISSUER
      secretKey: sheetAuthIssuer
    - name: TRUSTED_ORIGINS
      secretKey: trustedOrigins
  projectedTokens:
    - path: sheet-auth-token
      audience: sheet-auth
    - path: sheet-apis-token
      audience: sheet-apis
    - path: sheet-workflows-token
      audience: sheet-workflows
    - path: sheet-bot-token
      audience: sheet-bot
  networkPolicyFrom:
    - app: sheet-apis
      port: ingress-svc
    - app: sheet-bot
      port: ingress-svc
    - app: sheet-workflows
      port: ingress-svc
- key: sheetWeb
  name: sheet-web
  portName: sheet-web-svc
  metricPortName: sheet-web-met
  secretName: sheet-web-secret
  servicePorts:
    - name: sheet-web-svc
      port: 80
      targetPort: sheet-web-svc
    - name: sheet-web-met
      port: 9464
      targetPort: sheet-web-met
  containerPorts:
    - name: sheet-web-svc
      containerPort: 3000
    - name: sheet-web-met
      containerPort: 9464
  env:
    - name: OTEL_EXPORTER_OTLP_ENDPOINT
      secretKey: otelExporterOtlpEndpoint
    - name: AUTH_BASE_URL
      secretKey: authBaseUrl
    - name: APP_BASE_URL
      secretKey: appBaseUrl
    - name: SHEET_APIS_BASE_URL
      secretKey: sheetApisBaseUrl
{{- end -}}
