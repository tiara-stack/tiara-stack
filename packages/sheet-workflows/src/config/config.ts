import { Config, Schema } from "effect";

const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const nonEmptyString = Schema.NonEmptyString;
const nonEmptySecret = Schema.Redacted(nonEmptyString);

export const config = {
  port: Config.port("PORT").pipe(Config.withDefault(3000)),
  podNamespace: Config.string("POD_NAMESPACE"),
  sheetAuthIssuer: Config.schema(Schema.String, "SHEET_AUTH_ISSUER"),
  sheetAuthOAuthClientId: Config.schema(nonEmptyString, "SHEET_AUTH_OAUTH_CLIENT_ID"),
  sheetAuthOAuthClientSecret: Config.schema(nonEmptySecret, "SHEET_AUTH_OAUTH_CLIENT_SECRET"),
  sheetIngressBaseUrl: Config.schema(Schema.String, "SHEET_INGRESS_BASE_URL"),
  sheetAuthOAuthAudience: Config.string("SHEET_AUTH_OAUTH_AUDIENCE").pipe(
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
  workflowsSmokeWorkflowEnabled: Config.boolean("WORKFLOWS_SMOKE_WORKFLOW_ENABLED").pipe(
    Config.withDefault(false),
  ),
};
