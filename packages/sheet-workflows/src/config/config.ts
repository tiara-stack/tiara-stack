import { Config, Effect, Schema } from "effect";

const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const boundedScreenshotBrowserConcurrency = positiveInt.check(Schema.isLessThanOrEqualTo(16));
const nonEmptyString = Schema.NonEmptyString;
const nonEmptySecret = Schema.Redacted(nonEmptyString);

const WorkflowRole = Schema.Literals(["combined", "api", "runner", "browser-runner"]);

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
  sheetBotBaseUrl: Config.string("SHEET_BOT_BASE_URL").pipe(
    Config.withDefault("http://sheet-bot:3000"),
  ),
  sheetBotClientId: Config.string("SHEET_BOT_CLIENT_ID").pipe(Config.withDefault("discord-main")),
  sheetBotGatewayServiceId: Config.schema(nonEmptyString, "SHEET_BOT_GATEWAY_SERVICE_ID").pipe(
    Config.withDefault("sheet-bot.gateway"),
  ),
  sheetBotGatewayOAuthClientId: Config.schema(nonEmptyString, "SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID"),
  sheetAutoRoleCleanupServiceId: Config.schema(
    nonEmptyString,
    "SHEET_AUTO_ROLE_CLEANUP_SERVICE_ID",
  ).pipe(Config.withDefault("auto-role-cleanup")),
  sheetAutoCheckinServiceId: Config.schema(nonEmptyString, "SHEET_AUTO_CHECKIN_SERVICE_ID"),
  sheetAutoCheckinOAuthClientId: Config.schema(
    nonEmptyString,
    "SHEET_AUTO_CHECKIN_OAUTH_CLIENT_ID",
  ),
  sheetAuthOAuthAudience: Config.string("SHEET_AUTH_OAUTH_AUDIENCE").pipe(
    Config.withDefault("sheet-workflows"),
  ),
  sheetAuthWorkflowHttpAudience: Config.string("SHEET_AUTH_WORKFLOW_HTTP_AUDIENCE").pipe(
    Config.withDefault("sheet-workflows-http"),
  ),
  // Browser workflow requests use a separate resource audience. Keep this
  // opt-in so an HTTP deployment does not silently trust an additional token
  // audience for every workflow route.
  sheetAuthWorkflowHttpBrowserAudience: Config.option(
    Config.string("SHEET_AUTH_WORKFLOW_HTTP_BROWSER_AUDIENCE"),
  ),
  sheetWebBaseUrl: Config.schema(Schema.URL, "SHEET_WEB_BASE_URL").pipe(
    Config.withDefault(new URL("http://localhost:3001")),
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
  trustedSheetPersistenceMaxConnections: Config.schema(
    positiveInt,
    "TRUSTED_SHEET_PERSISTENCE_MAX_CONNECTIONS",
  ).pipe(Config.withDefault(10)),
  trustedSheetPersistenceStatementTimeoutMillis: Config.schema(
    positiveInt,
    "TRUSTED_SHEET_PERSISTENCE_STATEMENT_TIMEOUT_MILLIS",
  ).pipe(Config.withDefault(30_000)),
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
  screenshotBrowserConcurrency: Config.schema(
    boundedScreenshotBrowserConcurrency,
    "SCREENSHOT_BROWSER_CONCURRENCY",
  ).pipe(Config.withDefault(2)),
  workflowsSmokeWorkflowEnabled: Config.boolean("WORKFLOWS_SMOKE_WORKFLOW_ENABLED").pipe(
    Config.withDefault(false),
  ),
};
