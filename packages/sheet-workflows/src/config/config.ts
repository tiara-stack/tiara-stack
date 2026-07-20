import { Config, Effect, Schema } from "effect";

const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const nonEmptyString = Schema.NonEmptyString;
const nonEmptySecret = Schema.Redacted(nonEmptyString);

const WorkflowRole = Schema.Literals(["combined", "api", "runner"]);

export const config = {
  port: Config.port("PORT").pipe(Config.withDefault(3000)),
  podNamespace: Config.string("POD_NAMESPACE"),
  sheetWorkflowsRole: Config.string("SHEET_WORKFLOWS_ROLE").pipe(
    Config.withDefault("combined"),
    Config.mapOrFail((value) =>
      Schema.decodeUnknownEffect(WorkflowRole)(value).pipe(
        Effect.mapError((error) => new Config.ConfigError(error)),
      ),
    ),
  ),
  sheetAuthIssuer: Config.schema(Schema.String, "SHEET_AUTH_ISSUER"),
  sheetAuthOAuthClientId: Config.schema(nonEmptyString, "SHEET_AUTH_OAUTH_CLIENT_ID"),
  sheetAuthOAuthClientSecret: Config.schema(nonEmptySecret, "SHEET_AUTH_OAUTH_CLIENT_SECRET"),
  sheetIngressBaseUrl: Config.schema(Schema.String, "SHEET_INGRESS_BASE_URL"),
  sheetAuthOAuthAudience: Config.string("SHEET_AUTH_OAUTH_AUDIENCE").pipe(
    Config.withDefault("sheet-workflows"),
  ),
  sheetAuthTrustedDelegationClientIds: Config.string(
    "SHEET_AUTH_TRUSTED_DELEGATION_CLIENT_IDS",
  ).pipe(
    Config.map((value) => {
      const clientIds: string[] = [];
      for (const entry of value.split(",")) {
        const clientId = entry.trim();
        if (clientId.length > 0) {
          clientIds.push(clientId);
        }
      }
      return clientIds;
    }),
    Config.mapOrFail((clientIds) =>
      Schema.decodeUnknownEffect(Schema.NonEmptyArray(nonEmptyString))(clientIds).pipe(
        Effect.mapError((error) => new Config.ConfigError(error)),
      ),
    ),
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
  workflowsRunnerHealthLabelSelector: Config.string("WORKFLOWS_RUNNER_HEALTH_LABEL_SELECTOR").pipe(
    Config.withDefault("app=sheet-workflows"),
    Config.mapOrFail((value) =>
      Schema.decodeUnknownEffect(nonEmptyString)(value).pipe(
        Effect.mapError((error) => new Config.ConfigError(error)),
      ),
    ),
  ),
  // Tune this for large auto-check-in fleets to bound concurrent workflow enqueues.
  autoCheckinConcurrency: Config.schema(positiveInt, "AUTO_CHECKIN_CONCURRENCY").pipe(
    Config.withDefault(50),
  ),
  // Bound automatic kick conversations independently from check-in workflow enqueues.
  autoKickConcurrency: Config.schema(positiveInt, "AUTO_KICK_CONCURRENCY").pipe(
    Config.withDefault(4),
  ),
  workflowsSmokeWorkflowEnabled: Config.boolean("WORKFLOWS_SMOKE_WORKFLOW_ENABLED").pipe(
    Config.withDefault(false),
  ),
};
