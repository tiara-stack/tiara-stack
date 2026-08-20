import { readFile } from "node:fs/promises";
import type { DiscordInteraction } from "dfx/Interactions/context";
import { Interaction } from "dfx-discord-utils";
import {
  Cache,
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Redacted,
  Random,
  Schedule,
  Schema,
} from "effect";
import { HttpClient } from "effect/unstable/http";
import {
  createOAuthClientCredentialsToken,
  createOAuthSubjectToken,
  exchangeOAuthToken,
} from "sheet-auth/client";
import {
  makeSheetWorkflowHttpClients,
  makeWorkflowInvocationId,
  WorkflowTransportUnavailable,
  type SheetWorkflowHttpClients,
} from "sheet-workflow-http-client";
import { config } from "@/config";
import { makeCachedBearerTokenHttpClient } from "./oauthHttpClient";
import { SheetAuthClient } from "./sheetAuthClient";

const accessTokenType = "urn:ietf:params:oauth:token-type:access_token";
const workflowHttpAudience = "sheet-workflows-http";
const workflowRequesterTokenCacheCapacity = 500;
const workflowEnqueueTimeout = Duration.seconds(30);

const workflowHttpRequesterActorScopes = ["service", "token.exchange", "workflow.enqueue"] as const;

export type ServicesDeliverStatusEnqueue =
  SheetWorkflowHttpClients["services"]["deliverStatus"]["enqueue"];
export type ServicesDeliverStatusInput = Parameters<ServicesDeliverStatusEnqueue>[0];
export type ServicesDeliverStatusReference = Effect.Success<
  ReturnType<ServicesDeliverStatusEnqueue>
>;
export type ServicesDeliverStatusEnqueueError = Effect.Error<
  ReturnType<ServicesDeliverStatusEnqueue>
>;

type SheetWorkflowHttpRequestContextType = {
  readonly discordUserId: string;
};

class InvalidDiscordUser extends Schema.TaggedErrorClass<InvalidDiscordUser>()(
  "InvalidDiscordUser",
  { message: Schema.String },
) {}

const sheetWorkflowHttpRequestContextTag = Context.Service<SheetWorkflowHttpRequestContextType>(
  "SheetWorkflowHttpRequestContext",
);

const discordUserIdFromUnknown = (value: unknown) =>
  Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(value).pipe(
    Effect.mapError(
      () => new InvalidDiscordUser({ message: "Discord interaction user is invalid" }),
    ),
    Effect.flatMap(({ id }) => requireDiscordUserId(id)),
  );

const requireDiscordUserId = (discordUserId: string) =>
  discordUserId.trim().length > 0
    ? Effect.succeed(discordUserId.trim())
    : Effect.fail(new InvalidDiscordUser({ message: "Discord user ID is required" }));

const errorLogDetails = (error: unknown) => ({
  errorTag:
    Predicate.hasProperty("_tag")(error) && Predicate.isString(error._tag) ? error._tag : undefined,
  errorMessage:
    Predicate.hasProperty("message")(error) && Predicate.isString(error.message)
      ? error.message
      : undefined,
});

export const SheetWorkflowHttpRequestContext = Object.assign(sheetWorkflowHttpRequestContextTag, {
  asDiscordUser: <Args extends any[], A, E, R>(
    discordUserId: string,
    fn: (...args: Args) => Effect.Effect<A, E, R>,
  ) =>
    Effect.fn("SheetWorkflowHttpRequestContext.asDiscordUser")(function* (...args: Args) {
      const validDiscordUserId = yield* requireDiscordUserId(discordUserId);
      return yield* fn(...args).pipe(
        Effect.provideService(sheetWorkflowHttpRequestContextTag, {
          discordUserId: validDiscordUserId,
        }),
      );
    }),

  asInteractionUser: <Args extends any[], A, E, R>(fn: (...args: Args) => Effect.Effect<A, E, R>) =>
    Effect.fn("SheetWorkflowHttpRequestContext.asInteractionUser")(function* (...args: Args) {
      const interactionUser = yield* Interaction.user();
      const discordUserId = yield* discordUserIdFromUnknown(interactionUser);
      return yield* fn(...args).pipe(
        Effect.provideService(sheetWorkflowHttpRequestContextTag, {
          discordUserId,
        }),
      );
    }),
}) as typeof sheetWorkflowHttpRequestContextTag & {
  readonly asDiscordUser: <Args extends any[], A, E, R>(
    discordUserId: string,
    fn: (...args: Args) => Effect.Effect<A, E, R>,
  ) => (
    ...args: Args
  ) => Effect.Effect<
    A,
    E | InvalidDiscordUser,
    Exclude<R, typeof sheetWorkflowHttpRequestContextTag>
  >;
  readonly asInteractionUser: <Args extends any[], A, E, R>(
    fn: (...args: Args) => Effect.Effect<A, E, R>,
  ) => (
    ...args: Args
  ) => Effect.Effect<
    A,
    E | InvalidDiscordUser,
    DiscordInteraction | Exclude<R, typeof sheetWorkflowHttpRequestContextTag>
  >;
};

const readKubernetesServiceAccountToken = (path: string) =>
  Effect.tryPromise({
    try: async () => Redacted.make((await readFile(path, "utf8")).trim()),
    catch: (cause) => cause,
  });

const workflowSubjectTokenOptions = (
  discordUserId: string,
  kubernetesServiceAccountToken: Redacted.Redacted<string>,
) => ({
  subject: `discord:${discordUserId}`,
  expiresIn: 60,
  kubernetesServiceAccountToken,
});

const makeDiscordUserToken = Effect.fn("SheetWorkflowHttpClient.makeDiscordUserToken")(function* ({
  accessToken,
  discordUserId,
  kubernetesServiceAccountTokenPath,
  sheetAuthClient,
}: {
  readonly accessToken: Redacted.Redacted<string>;
  readonly discordUserId: string;
  readonly kubernetesServiceAccountTokenPath: string;
  readonly sheetAuthClient: typeof SheetAuthClient.Service;
}) {
  const kubernetesServiceAccountToken = yield* readKubernetesServiceAccountToken(
    kubernetesServiceAccountTokenPath,
  );
  const subjectToken = yield* createOAuthSubjectToken(
    sheetAuthClient,
    workflowSubjectTokenOptions(discordUserId, kubernetesServiceAccountToken),
  );

  return yield* exchangeOAuthToken(sheetAuthClient, {
    subjectToken: subjectToken.subjectToken,
    subjectTokenType: subjectToken.subjectTokenType,
    actorToken: accessToken,
    actorTokenType: accessTokenType,
    requestedTokenType: accessTokenType,
    audience: workflowHttpAudience,
    scope: ["workflow.enqueue"],
  });
});

export interface SheetWorkflowHttpClientShape {
  readonly enqueueServicesDeliverStatus: ServicesDeliverStatusEnqueue;
}

export class SheetWorkflowHttpClient extends Context.Service<
  SheetWorkflowHttpClient,
  SheetWorkflowHttpClientShape
>()("SheetWorkflowHttpClient", {
  make: Effect.gen(function* () {
    const sheetAuthClient = yield* SheetAuthClient;
    const httpClient = yield* HttpClient.HttpClient;
    const baseUrl = yield* config.sheetWorkflowsBaseUrl;
    const oauthClientId = yield* config.sheetAuthOAuthClientId;
    const oauthClientSecret = yield* config.sheetAuthOAuthClientSecret;
    const subjectTokenKubernetesTokenPath = yield* config.sheetAuthSubjectTokenKubernetesTokenPath;

    const httpClientWithToken = yield* makeCachedBearerTokenHttpClient({
      httpClient,
      cacheCapacity: workflowRequesterTokenCacheCapacity,
      lookupName: "SheetWorkflowHttpClient.lookup",
      lookup: (discordUserId) =>
        Effect.gen(function* () {
          const correlationId = yield* Random.nextUUIDv4;
          return yield* Effect.gen(function* () {
            const actorToken = yield* createOAuthClientCredentialsToken(sheetAuthClient, {
              clientId: oauthClientId,
              clientSecret: oauthClientSecret,
              scope: workflowHttpRequesterActorScopes,
              resource: workflowHttpAudience,
            });
            const exchangedToken = yield* makeDiscordUserToken({
              accessToken: actorToken.accessToken,
              discordUserId,
              kubernetesServiceAccountTokenPath: subjectTokenKubernetesTokenPath,
              sheetAuthClient,
            });
            const now = yield* Clock.currentTimeMillis;
            const timeToLiveMs = exchangedToken.expiresAt * 1000 - now - 60_000;
            if (timeToLiveMs <= 0) {
              return yield* Effect.fail(new Error("OAuth token has insufficient lifetime"));
            }
            return {
              token: exchangedToken.accessToken,
              timeToLive: Duration.millis(timeToLiveMs),
              failed: false,
            };
          }).pipe(
            Effect.matchEffect({
              onSuccess: Effect.succeed,
              onFailure: (error) =>
                Effect.logError("Failed to create OAuth token for sheet-workflows HTTP request", {
                  correlationId,
                  ...errorLogDetails(error),
                }).pipe(
                  Effect.as({
                    token: undefined,
                    timeToLive: Duration.minutes(1),
                    failed: true,
                  }),
                ),
            }),
          );
        }),
      missingToken: Effect.fail(
        new Error("Failed to get auth token for sheet-workflows HTTP request"),
      ),
      tokenEntry: (tokenCache) =>
        Effect.gen(function* () {
          const context = yield* Effect.serviceOption(sheetWorkflowHttpRequestContextTag);
          if (Option.isNone(context)) {
            return yield* Effect.fail(
              new InvalidDiscordUser({ message: "Discord user context is required" }),
            );
          }
          const { discordUserId: contextDiscordUserId } = context.value;
          const discordUserId = yield* requireDiscordUserId(contextDiscordUserId);
          return yield* Cache.get(tokenCache, discordUserId);
        }),
    });

    const clients = makeSheetWorkflowHttpClients(httpClientWithToken, {
      baseUrl,
    });

    return {
      enqueueServicesDeliverStatus: clients.services.deliverStatus.enqueue,
    } satisfies SheetWorkflowHttpClientShape;
  }),
}) {
  static layer = Layer.effect(SheetWorkflowHttpClient, this.make).pipe(
    Layer.provide(SheetAuthClient.layer),
  );
}

export const enqueueStatusWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueServicesDeliverStatus">,
  input: ServicesDeliverStatusInput,
) => {
  return makeWorkflowInvocationId().pipe(
    Effect.flatMap((invocationId) =>
      Effect.suspend(() => client.enqueueServicesDeliverStatus(input, { invocationId })).pipe(
        Effect.timeout(workflowEnqueueTimeout),
        Effect.mapError((error) =>
          Cause.isTimeoutError(error)
            ? new WorkflowTransportUnavailable({
                operation: "Enqueue",
                retryable: true,
                message: "Workflow enqueue timed out",
              })
            : error,
        ),
        Effect.retry({
          schedule: Schedule.spaced(Duration.millis(100)).pipe(Schedule.take(1)),
          while: (error) =>
            Predicate.isTagged("WorkflowTransportUnavailable")(error) && error.retryable,
        }),
      ),
    ),
  );
};
