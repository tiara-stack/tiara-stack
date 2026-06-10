import { Config, Schema } from "effect";

const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const config = {
  port: Config.port("PORT").pipe(Config.withDefault(3000)),
  podNamespace: Config.string("POD_NAMESPACE"),
  sheetAuthIssuer: Config.schema(Schema.String, "SHEET_AUTH_ISSUER"),
  sheetAuthOAuthIntrospectionClientId: Config.option(
    Config.schema(Schema.String, "SHEET_AUTH_INTROSPECTION_CLIENT_ID"),
  ),
  sheetAuthOAuthIntrospectionClientSecret: Config.option(
    Config.schema(Schema.Redacted(Schema.String), "SHEET_AUTH_INTROSPECTION_CLIENT_SECRET"),
  ),
  sheetIngressBaseUrl: Config.schema(Schema.String, "SHEET_INGRESS_BASE_URL"),
  sheetIngressKubernetesAudience: Config.string("SHEET_INGRESS_KUBERNETES_AUDIENCE").pipe(
    Config.withDefault("sheet-workflows"),
  ),
  postgresUrl: Config.schema(Schema.Redacted(Schema.String), "POSTGRES_URL"),
  workflowsRunnerHost: Config.string("WORKFLOWS_RUNNER_HOST"),
  workflowsRunnerPort: Config.port("WORKFLOWS_RUNNER_PORT").pipe(Config.withDefault(34431)),
  workflowsRunnerListenHost: Config.string("WORKFLOWS_RUNNER_LISTEN_HOST").pipe(
    Config.withDefault("0.0.0.0"),
  ),
  workflowsRunnerListenPort: Config.port("WORKFLOWS_RUNNER_LISTEN_PORT").pipe(
    Config.withDefault(34431),
  ),
  // Tune this for large auto-check-in fleets to bound concurrent workflow enqueues.
  autoCheckinConcurrency: Config.schema(positiveInt, "AUTO_CHECKIN_CONCURRENCY").pipe(
    Config.withDefault(50),
  ),
  sheetServiceOAuthClientId: Config.option(
    Config.schema(Schema.String, "SHEET_WORKFLOWS_SERVICE_CLIENT_ID"),
  ),
  sheetServiceOAuthClientSecret: Config.option(
    Config.schema(Schema.Redacted(Schema.String), "SHEET_WORKFLOWS_SERVICE_CLIENT_SECRET"),
  ),
  workflowsSmokeWorkflowEnabled: Config.boolean("WORKFLOWS_SMOKE_WORKFLOW_ENABLED").pipe(
    Config.withDefault(false),
  ),
};
