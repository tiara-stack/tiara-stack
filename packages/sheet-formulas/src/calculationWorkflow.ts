import { Effect, Predicate, Redacted, Schedule, Schema } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpBody,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import {
  decodeWorkflowInvocationId,
  makeWorkflowInvocationId,
  type WorkflowInvocationId,
} from "sheet-workflow-http-client";
import {
  makeSheetWorkflowEnqueueClients,
  type SheetWorkflowEnqueueClients,
} from "sheet-workflow-http-client/apps-script";

const CALCULATION_INVOCATION_ID_PROPERTY = "SHEET_FORMULAS_CALCULATION_INVOCATION_ID";
const WORKFLOW_HTTP_BASE_URL_PROPERTY = "SHEET_WORKFLOWS_HTTP_BASE_URL";
const SHEET_AUTH_ISSUER_PROPERTY = "SHEET_AUTH_ISSUER";
const WORKFLOW_HTTP_CLIENT_SECRET_PROPERTY = "SHEET_WORKFLOWS_HTTP_CLIENT_SECRET";

export const calculationStatus = {
  submitting: "Submitting",
  queued: "Queued",
  didNotStart: "Did not start",
} as const;

export type CalculationStatus = (typeof calculationStatus)[keyof typeof calculationStatus];

export type CalculationProperties = {
  readonly getProperty: (name: string) => string | null;
  readonly setProperty: (name: string, value: string) => unknown;
  readonly deleteProperty: (name: string) => unknown;
};

export type CalculationEnqueueClient =
  SheetWorkflowEnqueueClients["calculations"]["recalculateSheet"];
export type CalculationInput = Parameters<CalculationEnqueueClient["enqueue"]>[0];
export type CalculationEnqueuer = {
  readonly enqueue: (
    input: CalculationInput,
    options: { readonly invocationId: WorkflowInvocationId },
  ) => Effect.Effect<unknown, unknown>;
};

export type AppsScriptWorkflowHttpConfiguration = {
  readonly baseUrl: string;
  readonly authIssuer: string;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
};

class AppsScriptWorkflowConfigurationError extends Schema.TaggedErrorClass<AppsScriptWorkflowConfigurationError>()(
  "AppsScriptWorkflowConfigurationError",
  {
    property: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

const OAuthTokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
});

const calculationRetrySchedule = Schedule.recurs(1);

const isRetryableTransportUnavailable = (error: unknown): boolean =>
  Predicate.isTagged("WorkflowTransportUnavailable")(error) &&
  Predicate.hasProperty("retryable")(error) &&
  Predicate.isTruthy(error.retryable);

const requiredProperty = (properties: CalculationProperties, name: string) =>
  Effect.try({
    try: () => properties.getProperty(name)?.trim(),
    catch: (cause) =>
      new AppsScriptWorkflowConfigurationError({
        property: name,
        message: `Apps Script property ${name} could not be read`,
        cause,
      }),
  }).pipe(
    Effect.flatMap((value) =>
      value
        ? Effect.succeed(value)
        : Effect.fail(
            new AppsScriptWorkflowConfigurationError({
              property: name,
              message: `Apps Script property ${name} is required`,
            }),
          ),
    ),
  );

export const workflowHttpConfiguration = (
  properties: CalculationProperties,
  spreadsheetId: string,
): Effect.Effect<AppsScriptWorkflowHttpConfiguration, AppsScriptWorkflowConfigurationError> =>
  Effect.gen(function* () {
    const baseUrl = yield* requiredProperty(properties, WORKFLOW_HTTP_BASE_URL_PROPERTY);
    const authIssuer = yield* requiredProperty(properties, SHEET_AUTH_ISSUER_PROPERTY);
    const clientSecret = yield* requiredProperty(properties, WORKFLOW_HTTP_CLIENT_SECRET_PROPERTY);

    return {
      baseUrl,
      authIssuer,
      clientId: `apps-script.installation:${spreadsheetId}`,
      clientSecret: Redacted.make(clientSecret),
    };
  });

const ACCESS_TOKEN_EXPIRY_SKEW_MILLIS = 60_000;

type WorkflowAccessToken = {
  readonly token: string;
  readonly expiresAt: number;
};

const makeWorkflowAccessToken = (
  httpClient: HttpClient.HttpClient,
  configuration: AppsScriptWorkflowHttpConfiguration,
) => {
  const request = HttpClientRequest.post(
    new URL("oauth2/token", `${configuration.authIssuer.replace(/\/?$/u, "/")}`),
  ).pipe(
    HttpClientRequest.bodyUrlParams(
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: configuration.clientId,
        client_secret: Redacted.value(configuration.clientSecret),
        scope: "service workflow.enqueue",
        resource: "sheet-workflows-http",
      }),
    ),
  );
  const requestWithoutBody = HttpClientRequest.setBody(request, HttpBody.empty);

  return request.pipe(
    httpClient.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(OAuthTokenResponse)),
    Effect.map(({ access_token, expires_in }) => ({
      token: access_token,
      expiresAt: Date.now() + Math.max(0, expires_in * 1000 - ACCESS_TOKEN_EXPIRY_SKEW_MILLIS),
    })),
    Effect.mapError(
      (error) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request: requestWithoutBody,
            description: HttpClientError.isHttpClientError(error)
              ? error.message
              : "Workflow access token request failed",
          }),
        }),
    ),
  );
};

export const makeAppsScriptWorkflowEnqueueClients = (
  httpClient: HttpClient.HttpClient,
  configuration: AppsScriptWorkflowHttpConfiguration,
): SheetWorkflowEnqueueClients => {
  let accessToken: WorkflowAccessToken | undefined;
  const authorizedHttpClient = HttpClient.mapRequestEffect(httpClient, (request) =>
    (accessToken === undefined || accessToken.expiresAt <= Date.now()
      ? makeWorkflowAccessToken(httpClient, configuration).pipe(
          Effect.tap((token) => Effect.sync(() => (accessToken = token))),
        )
      : Effect.succeed(accessToken)
    ).pipe(Effect.map(({ token }) => HttpClientRequest.bearerToken(request, Redacted.make(token)))),
  );

  return makeSheetWorkflowEnqueueClients(authorizedHttpClient, {
    baseUrl: configuration.baseUrl,
  });
};

const persistCalculationInvocationId = (
  properties: CalculationProperties,
  invocationId: WorkflowInvocationId,
  input: CalculationInput,
) => {
  const serialized = serializeCalculationInvocation({ invocationId, input });
  return Effect.try({
    try: () => {
      properties.setProperty(CALCULATION_INVOCATION_ID_PROPERTY, serialized);
      return serialized;
    },
    catch: (error) => error,
  });
};

const calculationInvocationRecordSchema = Schema.Struct({
  invocationId: Schema.String,
  spreadsheetId: Schema.String,
  sheetRef: Schema.String,
  inputFingerprint: Schema.String,
});
const calculationInvocationRecordJsonSchema = Schema.fromJsonString(
  calculationInvocationRecordSchema,
);

export const calculationInputFingerprint = (input: CalculationInput): string =>
  JSON.stringify({
    spreadsheetId: input.spreadsheetId,
    sheetRef: input.sheetRef,
    hour: input.hour,
    config: {
      cc: input.config.cc,
      considerEnc: input.config.considerEnc,
      healNeeded: input.config.healNeeded,
    },
    players: input.players.map(({ name, encable }) => ({ name, encable })),
    fixedTeams: input.fixedTeams.map(({ name, heal }) => ({ name, heal })),
  }) ?? "";

const serializeCalculationInvocation = ({
  invocationId,
  input,
}: {
  readonly invocationId: WorkflowInvocationId;
  readonly input: CalculationInput;
}): string =>
  JSON.stringify({
    invocationId,
    spreadsheetId: input.spreadsheetId,
    sheetRef: input.sheetRef,
    inputFingerprint: calculationInputFingerprint(input),
  });

const clearCalculationInvocationId = (
  properties: CalculationProperties,
  expectedSerialized: string,
) =>
  Effect.try({
    try: () => {
      if (properties.getProperty(CALCULATION_INVOCATION_ID_PROPERTY) === expectedSerialized) {
        properties.deleteProperty(CALCULATION_INVOCATION_ID_PROPERTY);
      }
    },
    catch: (error) => error,
  }).pipe(Effect.catch((error) => Effect.logError(error)));

export const makeCalculationInvocationId = (
  properties: CalculationProperties,
  input: CalculationInput,
  generateInvocationId: () => ReturnType<
    typeof makeWorkflowInvocationId
  > = makeWorkflowInvocationId,
) =>
  Effect.try({
    try: () => properties.getProperty(CALCULATION_INVOCATION_ID_PROPERTY),
    catch: (error) => error,
  }).pipe(
    Effect.flatMap((persistedSerialized) =>
      persistedSerialized === null
        ? generateInvocationId()
        : Schema.decodeUnknownEffect(calculationInvocationRecordJsonSchema)(
            persistedSerialized,
          ).pipe(
            Effect.flatMap((persisted) =>
              decodeWorkflowInvocationId(persisted.invocationId).pipe(
                Effect.flatMap((invocationId) =>
                  persisted.spreadsheetId === input.spreadsheetId &&
                  persisted.sheetRef === input.sheetRef &&
                  persisted.inputFingerprint === calculationInputFingerprint(input)
                    ? Effect.succeed(invocationId)
                    : clearCalculationInvocationId(properties, persistedSerialized).pipe(
                        Effect.andThen(generateInvocationId()),
                      ),
                ),
              ),
            ),
            Effect.catch(() =>
              clearCalculationInvocationId(properties, persistedSerialized).pipe(
                Effect.andThen(generateInvocationId()),
              ),
            ),
          ),
    ),
  );

const enqueueCalculation = (
  client: CalculationEnqueuer,
  input: CalculationInput,
  invocationId: WorkflowInvocationId,
) =>
  Effect.suspend(() => client.enqueue(input, { invocationId })).pipe(
    Effect.retry({
      schedule: calculationRetrySchedule,
      while: isRetryableTransportUnavailable,
    }),
  );

export const submitCalculation = ({
  properties,
  client,
  input,
  invocationId,
  beforeRequest,
}: {
  readonly properties: CalculationProperties;
  readonly client: CalculationEnqueuer;
  readonly input: CalculationInput;
  readonly invocationId: WorkflowInvocationId;
  readonly beforeRequest: Effect.Effect<void, unknown>;
}) =>
  Effect.gen(function* () {
    const serializedInvocation = yield* persistCalculationInvocationId(
      properties,
      invocationId,
      input,
    );
    yield* beforeRequest.pipe(
      Effect.tapError(() => clearCalculationInvocationId(properties, serializedInvocation)),
    );
    return yield* enqueueCalculation(client, input, invocationId).pipe(
      Effect.tap(() => clearCalculationInvocationId(properties, serializedInvocation)),
      Effect.tapError((error) =>
        isRetryableTransportUnavailable(error)
          ? Effect.void
          : clearCalculationInvocationId(properties, serializedInvocation),
      ),
    );
  });

export const calculationStatusForOutcome = (
  outcome: "accepted" | "definitive-rejection" | "ambiguous",
): CalculationStatus =>
  ({
    accepted: calculationStatus.queued,
    "definitive-rejection": calculationStatus.didNotStart,
    ambiguous: calculationStatus.submitting,
  })[outcome];

export const calculationStatusForError = (error: unknown): CalculationStatus =>
  calculationStatusForOutcome(
    isRetryableTransportUnavailable(error) ? "ambiguous" : "definitive-rejection",
  );

export const makeCalculationSheetReference = (sheetTitle: string): string => {
  const quotedTitle =
    /^[A-Za-z_][A-Za-z0-9_]*$/u.test(sheetTitle) && !/^[A-Za-z]+[1-9][0-9]*$/u.test(sheetTitle)
      ? sheetTitle
      : `'${sheetTitle.replaceAll("'", "''")}'`;
  return `${quotedTitle}!AX30:CC`;
};
