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
  makeRolloutGateHttpClient,
  makeSheetWorkflowHttpClients,
  makeWorkflowInvocationId,
  WorkflowTransportUnavailable,
  type WorkflowInvocationId,
  type SheetWorkflowHttpClients,
} from "sheet-workflow-http-client";
import { config } from "@/config";
import { makeCachedBearerTokenHttpClient } from "./oauthHttpClient";
import { SheetAuthClient } from "./sheetAuthClient";

const accessTokenType = "urn:ietf:params:oauth:token-type:access_token";
const workflowHttpAudience = "sheet-workflows-http";
const workflowRequesterTokenCacheCapacity = 500;
const workflowEnqueueTimeout = Duration.seconds(30);

const workflowHttpRequesterActorScopes = [
  "service",
  "token.exchange",
  "workflow.enqueue",
  "rollout.gate.evaluate",
] as const;

export type ServicesDeliverStatusEnqueue =
  SheetWorkflowHttpClients["services"]["deliverStatus"]["enqueue"];
export type ServicesDeliverStatusInput = Parameters<ServicesDeliverStatusEnqueue>[0];
export type ServicesDeliverStatusReference = Effect.Success<
  ReturnType<ServicesDeliverStatusEnqueue>
>;
export type WorkflowRolloutGateEvaluation = ReturnType<
  typeof makeRolloutGateHttpClient
>["evaluate"];
export type StatusRolloutGateEvaluation = WorkflowRolloutGateEvaluation;
export type SchedulesDeliverUserScheduleEnqueue =
  SheetWorkflowHttpClients["schedules"]["deliverUserSchedule"]["enqueue"];
export type SchedulesDeliverUserScheduleInput = Parameters<SchedulesDeliverUserScheduleEnqueue>[0];
export type SchedulesDeliverUserScheduleReference = Effect.Success<
  ReturnType<SchedulesDeliverUserScheduleEnqueue>
>;
export type ScheduleRolloutGateEvaluation = WorkflowRolloutGateEvaluation;

export type CheckinsOpenEnqueue = SheetWorkflowHttpClients["checkins"]["open"]["enqueue"];
export type CheckinsOpenInput = Parameters<CheckinsOpenEnqueue>[0];
export type CheckinsOpenReference = Effect.Success<ReturnType<CheckinsOpenEnqueue>>;
// fallow-ignore-next-line unused-type
export type CheckinsOpenEnqueueError = Effect.Error<ReturnType<CheckinsOpenEnqueue>>;

export type CheckinsTestAutoEnqueue = SheetWorkflowHttpClients["checkins"]["testAuto"]["enqueue"];
export type CheckinsTestAutoInput = Parameters<CheckinsTestAutoEnqueue>[0];
export type CheckinsTestAutoReference = Effect.Success<ReturnType<CheckinsTestAutoEnqueue>>;
// fallow-ignore-next-line unused-type
export type CheckinsTestAutoEnqueueError = Effect.Error<ReturnType<CheckinsTestAutoEnqueue>>;

export type CheckinsRespondEnqueue = SheetWorkflowHttpClients["checkins"]["respond"]["enqueue"];
export type CheckinsRespondInput = Parameters<CheckinsRespondEnqueue>[0];
export type CheckinsRespondReference = Effect.Success<ReturnType<CheckinsRespondEnqueue>>;
// fallow-ignore-next-line unused-type
export type CheckinsRespondEnqueueError = Effect.Error<ReturnType<CheckinsRespondEnqueue>>;

export type RoomOrdersCreateEnqueue = SheetWorkflowHttpClients["roomOrders"]["create"]["enqueue"];
export type RoomOrdersCreateInput = Parameters<RoomOrdersCreateEnqueue>[0];
export type RoomOrdersCreateReference = Effect.Success<ReturnType<RoomOrdersCreateEnqueue>>;
// fallow-ignore-next-line unused-type
export type RoomOrdersCreateEnqueueError = Effect.Error<ReturnType<RoomOrdersCreateEnqueue>>;

export type RoomOrdersNavigateEnqueue =
  SheetWorkflowHttpClients["roomOrders"]["navigate"]["enqueue"];
export type RoomOrdersNavigateInput = Parameters<RoomOrdersNavigateEnqueue>[0];
export type RoomOrdersNavigateReference = Effect.Success<ReturnType<RoomOrdersNavigateEnqueue>>;
// fallow-ignore-next-line unused-type
export type RoomOrdersNavigateEnqueueError = Effect.Error<ReturnType<RoomOrdersNavigateEnqueue>>;

export type RoomOrdersSendEnqueue = SheetWorkflowHttpClients["roomOrders"]["send"]["enqueue"];
export type RoomOrdersSendInput = Parameters<RoomOrdersSendEnqueue>[0];
export type RoomOrdersSendReference = Effect.Success<ReturnType<RoomOrdersSendEnqueue>>;
// fallow-ignore-next-line unused-type
export type RoomOrdersSendEnqueueError = Effect.Error<ReturnType<RoomOrdersSendEnqueue>>;

export type RoomOrdersPinTentativeEnqueue =
  SheetWorkflowHttpClients["roomOrders"]["pinTentative"]["enqueue"];
export type RoomOrdersPinTentativeInput = Parameters<RoomOrdersPinTentativeEnqueue>[0];
export type RoomOrdersPinTentativeReference = Effect.Success<
  ReturnType<RoomOrdersPinTentativeEnqueue>
>;
// fallow-ignore-next-line unused-type
export type RoomOrdersPinTentativeEnqueueError = Effect.Error<
  ReturnType<RoomOrdersPinTentativeEnqueue>
>;

export type SlotsDeliverListEnqueue = SheetWorkflowHttpClients["slots"]["deliverList"]["enqueue"];
export type SlotsDeliverListInput = Parameters<SlotsDeliverListEnqueue>[0];
export type SlotsDeliverListReference = Effect.Success<ReturnType<SlotsDeliverListEnqueue>>;
// fallow-ignore-next-line unused-type
export type SlotsDeliverListEnqueueError = Effect.Error<ReturnType<SlotsDeliverListEnqueue>>;

export type SlotsPublishButtonEnqueue =
  SheetWorkflowHttpClients["slots"]["publishButton"]["enqueue"];
export type SlotsPublishButtonInput = Parameters<SlotsPublishButtonEnqueue>[0];
export type SlotsPublishButtonReference = Effect.Success<ReturnType<SlotsPublishButtonEnqueue>>;
// fallow-ignore-next-line unused-type
export type SlotsPublishButtonEnqueueError = Effect.Error<ReturnType<SlotsPublishButtonEnqueue>>;

export type SlotsOpenEnqueue = SheetWorkflowHttpClients["slots"]["open"]["enqueue"];
export type SlotsOpenInput = Parameters<SlotsOpenEnqueue>[0];
export type SlotsOpenReference = Effect.Success<ReturnType<SlotsOpenEnqueue>>;
// fallow-ignore-next-line unused-type
export type SlotsOpenEnqueueError = Effect.Error<ReturnType<SlotsOpenEnqueue>>;

export type MembersKickEnqueue = SheetWorkflowHttpClients["members"]["kick"]["enqueue"];
export type MembersKickInput = Parameters<MembersKickEnqueue>[0];
export type MembersKickReference = Effect.Success<ReturnType<MembersKickEnqueue>>;
// fallow-ignore-next-line unused-type
export type MembersKickEnqueueError = Effect.Error<ReturnType<MembersKickEnqueue>>;

export type PreferencesDeliverStatusEnqueue =
  SheetWorkflowHttpClients["preferences"]["deliverStatus"]["enqueue"];
export type PreferencesDeliverStatusInput = Parameters<PreferencesDeliverStatusEnqueue>[0];
export type PreferencesDeliverStatusReference = Effect.Success<
  ReturnType<PreferencesDeliverStatusEnqueue>
>;
// fallow-ignore-next-line unused-type
export type PreferencesDeliverStatusEnqueueError = Effect.Error<
  ReturnType<PreferencesDeliverStatusEnqueue>
>;

export type PreferencesUpdateAndDeliverEnqueue =
  SheetWorkflowHttpClients["preferences"]["updateAndDeliver"]["enqueue"];
export type PreferencesUpdateAndDeliverInput = Parameters<PreferencesUpdateAndDeliverEnqueue>[0];
export type PreferencesUpdateAndDeliverReference = Effect.Success<
  ReturnType<PreferencesUpdateAndDeliverEnqueue>
>;
// fallow-ignore-next-line unused-type
export type PreferencesUpdateAndDeliverEnqueueError = Effect.Error<
  ReturnType<PreferencesUpdateAndDeliverEnqueue>
>;

export type WorkspacesDeliverConfigEnqueue =
  SheetWorkflowHttpClients["workspaces"]["deliverConfig"]["enqueue"];
export type WorkspacesDeliverConfigInput = Parameters<WorkspacesDeliverConfigEnqueue>[0];
export type WorkspacesDeliverConfigReference = Effect.Success<
  ReturnType<WorkspacesDeliverConfigEnqueue>
>;
// fallow-ignore-next-line unused-type
export type WorkspacesDeliverConfigEnqueueError = Effect.Error<
  ReturnType<WorkspacesDeliverConfigEnqueue>
>;

export type WorkspacesUpdateConfigAndDeliverEnqueue =
  SheetWorkflowHttpClients["workspaces"]["updateConfigAndDeliver"]["enqueue"];
export type WorkspacesUpdateConfigAndDeliverInput =
  Parameters<WorkspacesUpdateConfigAndDeliverEnqueue>[0];
export type WorkspacesUpdateConfigAndDeliverReference = Effect.Success<
  ReturnType<WorkspacesUpdateConfigAndDeliverEnqueue>
>;
// fallow-ignore-next-line unused-type
export type WorkspacesUpdateConfigAndDeliverEnqueueError = Effect.Error<
  ReturnType<WorkspacesUpdateConfigAndDeliverEnqueue>
>;

export type WorkspacesSetMonitorRoleAndDeliverEnqueue =
  SheetWorkflowHttpClients["workspaces"]["setMonitorRoleAndDeliver"]["enqueue"];
export type WorkspacesSetMonitorRoleAndDeliverInput =
  Parameters<WorkspacesSetMonitorRoleAndDeliverEnqueue>[0];
export type WorkspacesSetMonitorRoleAndDeliverReference = Effect.Success<
  ReturnType<WorkspacesSetMonitorRoleAndDeliverEnqueue>
>;
// fallow-ignore-next-line unused-type
export type WorkspacesSetMonitorRoleAndDeliverEnqueueError = Effect.Error<
  ReturnType<WorkspacesSetMonitorRoleAndDeliverEnqueue>
>;

export type WorkspacesFeatureFlagsSetAndDeliverEnqueue =
  SheetWorkflowHttpClients["workspaces"]["featureFlags"]["setAndDeliver"]["enqueue"];
export type WorkspacesFeatureFlagsSetAndDeliverInput =
  Parameters<WorkspacesFeatureFlagsSetAndDeliverEnqueue>[0];
export type WorkspacesFeatureFlagsSetAndDeliverReference = Effect.Success<
  ReturnType<WorkspacesFeatureFlagsSetAndDeliverEnqueue>
>;
// fallow-ignore-next-line unused-type
export type WorkspacesFeatureFlagsSetAndDeliverEnqueueError = Effect.Error<
  ReturnType<WorkspacesFeatureFlagsSetAndDeliverEnqueue>
>;

export type ConversationsDeliverConfigEnqueue =
  SheetWorkflowHttpClients["conversations"]["deliverConfig"]["enqueue"];
export type ConversationsDeliverConfigInput = Parameters<ConversationsDeliverConfigEnqueue>[0];
export type ConversationsDeliverConfigReference = Effect.Success<
  ReturnType<ConversationsDeliverConfigEnqueue>
>;
// fallow-ignore-next-line unused-type
export type ConversationsDeliverConfigEnqueueError = Effect.Error<
  ReturnType<ConversationsDeliverConfigEnqueue>
>;

export type ConversationsUpdateConfigAndDeliverEnqueue =
  SheetWorkflowHttpClients["conversations"]["updateConfigAndDeliver"]["enqueue"];
export type ConversationsUpdateConfigAndDeliverInput =
  Parameters<ConversationsUpdateConfigAndDeliverEnqueue>[0];
export type ConversationsUpdateConfigAndDeliverReference = Effect.Success<
  ReturnType<ConversationsUpdateConfigAndDeliverEnqueue>
>;
// fallow-ignore-next-line unused-type
export type ConversationsUpdateConfigAndDeliverEnqueueError = Effect.Error<
  ReturnType<ConversationsUpdateConfigAndDeliverEnqueue>
>;

export type ConversationsSetLockdownEnqueue =
  SheetWorkflowHttpClients["conversations"]["setLockdown"]["enqueue"];
export type ConversationsSetLockdownInput = Parameters<ConversationsSetLockdownEnqueue>[0];
export type ConversationsSetLockdownReference = Effect.Success<
  ReturnType<ConversationsSetLockdownEnqueue>
>;
// fallow-ignore-next-line unused-type
export type ConversationsSetLockdownEnqueueError = Effect.Error<
  ReturnType<ConversationsSetLockdownEnqueue>
>;

export type TeamsDeliverListEnqueue = SheetWorkflowHttpClients["teams"]["deliverList"]["enqueue"];
export type TeamsDeliverListInput = Parameters<TeamsDeliverListEnqueue>[0];
export type TeamsDeliverListReference = Effect.Success<ReturnType<TeamsDeliverListEnqueue>>;
// fallow-ignore-next-line unused-type
export type TeamsDeliverListEnqueueError = Effect.Error<ReturnType<TeamsDeliverListEnqueue>>;

export type ScreenshotsCaptureAndDeliverEnqueue =
  SheetWorkflowHttpClients["screenshots"]["captureAndDeliver"]["enqueue"];
export type ScreenshotsCaptureAndDeliverInput = Parameters<ScreenshotsCaptureAndDeliverEnqueue>[0];
export type ScreenshotsCaptureAndDeliverReference = Effect.Success<
  ReturnType<ScreenshotsCaptureAndDeliverEnqueue>
>;
// fallow-ignore-next-line unused-type
export type ScreenshotsCaptureAndDeliverEnqueueError = Effect.Error<
  ReturnType<ScreenshotsCaptureAndDeliverEnqueue>
>;

export type WorkspacesDeliverWelcomeEnqueue =
  SheetWorkflowHttpClients["workspaces"]["deliverWelcome"]["enqueue"];
export type WorkspacesDeliverWelcomeInput = Parameters<WorkspacesDeliverWelcomeEnqueue>[0];
export type WorkspacesDeliverWelcomeReference = Effect.Success<
  ReturnType<WorkspacesDeliverWelcomeEnqueue>
>;
// fallow-ignore-next-line unused-type
export type WorkspacesDeliverWelcomeEnqueueError = Effect.Error<
  ReturnType<WorkspacesDeliverWelcomeEnqueue>
>;

export type TeamSubmissionsProcessEnqueue =
  SheetWorkflowHttpClients["teamSubmissions"]["process"]["enqueue"];
export type TeamSubmissionsProcessInput = Parameters<TeamSubmissionsProcessEnqueue>[0];
export type TeamSubmissionsProcessReference = Effect.Success<
  ReturnType<TeamSubmissionsProcessEnqueue>
>;
// fallow-ignore-next-line unused-type
export type TeamSubmissionsProcessEnqueueError = Effect.Error<
  ReturnType<TeamSubmissionsProcessEnqueue>
>;

export type TeamSubmissionsDecideEnqueue =
  SheetWorkflowHttpClients["teamSubmissions"]["decide"]["enqueue"];
export type TeamSubmissionsDecideInput = Parameters<TeamSubmissionsDecideEnqueue>[0];
export type TeamSubmissionsDecideReference = Effect.Success<
  ReturnType<TeamSubmissionsDecideEnqueue>
>;
// fallow-ignore-next-line unused-type
export type TeamSubmissionsDecideEnqueueError = Effect.Error<
  ReturnType<TeamSubmissionsDecideEnqueue>
>;

export type AnnouncementsDeliverUpdateEnqueue =
  SheetWorkflowHttpClients["announcements"]["deliverUpdate"]["enqueue"];
export type AnnouncementsDeliverUpdateInput = Parameters<AnnouncementsDeliverUpdateEnqueue>[0];
export type AnnouncementsDeliverUpdateReference = Effect.Success<
  ReturnType<AnnouncementsDeliverUpdateEnqueue>
>;
// fallow-ignore-next-line unused-type
export type AnnouncementsDeliverUpdateEnqueueError = Effect.Error<
  ReturnType<AnnouncementsDeliverUpdateEnqueue>
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
    scope: ["workflow.enqueue", "rollout.gate.evaluate"],
  });
});

const makeWorkflowServiceHttpClient = Effect.fn("SheetWorkflowHttpClient.makeServiceHttpClient")(
  function* ({
    httpClient,
    oauthClientId,
    oauthClientSecret,
    sheetAuthClient,
  }: {
    readonly httpClient: HttpClient.HttpClient;
    readonly oauthClientId: string;
    readonly oauthClientSecret: Redacted.Redacted<string>;
    readonly sheetAuthClient: typeof SheetAuthClient.Service;
  }) {
    const serviceTokenKey = "sheet-bot.gateway";
    return yield* makeCachedBearerTokenHttpClient({
      httpClient,
      cacheCapacity: 1,
      lookupName: "SheetWorkflowHttpClient.serviceLookup",
      lookup: () =>
        createOAuthClientCredentialsToken(sheetAuthClient, {
          clientId: oauthClientId,
          clientSecret: oauthClientSecret,
          scope: ["service", "workflow.enqueue"],
          resource: workflowHttpAudience,
        }).pipe(
          Effect.flatMap((token) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const timeToLiveMs = token.expiresAt * 1000 - now - 60_000;
              if (timeToLiveMs <= 0) {
                return yield* Effect.fail(new Error("OAuth token has insufficient lifetime"));
              }
              return {
                token: token.accessToken,
                timeToLive: Duration.millis(timeToLiveMs),
                failed: false,
              };
            }),
          ),
          Effect.matchEffect({
            onSuccess: Effect.succeed,
            onFailure: (error) =>
              Effect.logError("Failed to create service OAuth token for sheet-workflows HTTP", {
                ...errorLogDetails(error),
              }).pipe(
                Effect.as({
                  token: undefined,
                  timeToLive: Duration.minutes(1),
                  failed: true,
                }),
              ),
          }),
        ),
      missingToken: Effect.fail(
        new Error("Failed to get service auth token for sheet-workflows HTTP request"),
      ),
      tokenEntry: (tokenCache) => Cache.get(tokenCache, serviceTokenKey),
    });
  },
);

export interface SheetWorkflowHttpClientShape {
  readonly enqueueServicesDeliverStatus: ServicesDeliverStatusEnqueue;
  readonly evaluateStatusRolloutGate: StatusRolloutGateEvaluation;
  readonly enqueueSchedulesDeliverUserSchedule: SchedulesDeliverUserScheduleEnqueue;
  readonly evaluateScheduleRolloutGate: ScheduleRolloutGateEvaluation;
  readonly enqueueCheckinsOpen: CheckinsOpenEnqueue;
  readonly evaluateCheckinsOpenRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueCheckinsTestAuto: CheckinsTestAutoEnqueue;
  readonly evaluateCheckinsTestAutoRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueCheckinsRespond: CheckinsRespondEnqueue;
  readonly evaluateCheckinsRespondRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueRoomOrdersCreate: RoomOrdersCreateEnqueue;
  readonly evaluateRoomOrdersCreateRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueRoomOrdersNavigate: RoomOrdersNavigateEnqueue;
  readonly evaluateRoomOrdersNavigateRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueRoomOrdersSend: RoomOrdersSendEnqueue;
  readonly evaluateRoomOrdersSendRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueRoomOrdersPinTentative: RoomOrdersPinTentativeEnqueue;
  readonly evaluateRoomOrdersPinTentativeRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueSlotsDeliverList: SlotsDeliverListEnqueue;
  readonly evaluateSlotsDeliverListRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueSlotsPublishButton: SlotsPublishButtonEnqueue;
  readonly evaluateSlotsPublishButtonRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueSlotsOpen: SlotsOpenEnqueue;
  readonly evaluateSlotsOpenRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueMembersKick: MembersKickEnqueue;
  readonly evaluateMembersKickRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueuePreferencesDeliverStatus: PreferencesDeliverStatusEnqueue;
  readonly evaluatePreferencesDeliverStatusRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueuePreferencesUpdateAndDeliver: PreferencesUpdateAndDeliverEnqueue;
  readonly evaluatePreferencesUpdateAndDeliverRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueWorkspacesDeliverConfig: WorkspacesDeliverConfigEnqueue;
  readonly evaluateWorkspacesDeliverConfigRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueWorkspacesUpdateConfigAndDeliver: WorkspacesUpdateConfigAndDeliverEnqueue;
  readonly evaluateWorkspacesUpdateConfigAndDeliverRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueWorkspacesSetMonitorRoleAndDeliver: WorkspacesSetMonitorRoleAndDeliverEnqueue;
  readonly evaluateWorkspacesSetMonitorRoleAndDeliverRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueWorkspacesFeatureFlagsSetAndDeliver: WorkspacesFeatureFlagsSetAndDeliverEnqueue;
  readonly evaluateWorkspacesFeatureFlagsSetAndDeliverRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueConversationsDeliverConfig: ConversationsDeliverConfigEnqueue;
  readonly evaluateConversationsDeliverConfigRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueConversationsUpdateConfigAndDeliver: ConversationsUpdateConfigAndDeliverEnqueue;
  readonly evaluateConversationsUpdateConfigAndDeliverRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueConversationsSetLockdown: ConversationsSetLockdownEnqueue;
  readonly evaluateConversationsSetLockdownRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueTeamsDeliverList: TeamsDeliverListEnqueue;
  readonly evaluateTeamsDeliverListRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueScreenshotsCaptureAndDeliver: ScreenshotsCaptureAndDeliverEnqueue;
  readonly evaluateScreenshotsCaptureAndDeliverRolloutGate: WorkflowRolloutGateEvaluation;
  readonly enqueueWorkspacesDeliverWelcome: WorkspacesDeliverWelcomeEnqueue;
  readonly enqueueTeamSubmissionsProcess: TeamSubmissionsProcessEnqueue;
  readonly enqueueTeamSubmissionsDecide: TeamSubmissionsDecideEnqueue;
  readonly enqueueAnnouncementsDeliverUpdate: AnnouncementsDeliverUpdateEnqueue;
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
    const serviceHttpClientWithToken = yield* makeWorkflowServiceHttpClient({
      httpClient,
      oauthClientId,
      oauthClientSecret,
      sheetAuthClient,
    });

    const clients = makeSheetWorkflowHttpClients(httpClientWithToken, {
      baseUrl,
    });
    const serviceClients = makeSheetWorkflowHttpClients(serviceHttpClientWithToken, {
      baseUrl,
    });
    const rolloutGateClient = makeRolloutGateHttpClient(httpClientWithToken, { baseUrl });

    return {
      enqueueServicesDeliverStatus: clients.services.deliverStatus.enqueue,
      evaluateStatusRolloutGate: rolloutGateClient.evaluate,
      enqueueSchedulesDeliverUserSchedule: clients.schedules.deliverUserSchedule.enqueue,
      evaluateScheduleRolloutGate: rolloutGateClient.evaluate,
      enqueueCheckinsOpen: clients.checkins.open.enqueue,
      evaluateCheckinsOpenRolloutGate: rolloutGateClient.evaluate,
      enqueueCheckinsTestAuto: clients.checkins.testAuto.enqueue,
      evaluateCheckinsTestAutoRolloutGate: rolloutGateClient.evaluate,
      enqueueCheckinsRespond: clients.checkins.respond.enqueue,
      evaluateCheckinsRespondRolloutGate: rolloutGateClient.evaluate,
      enqueueRoomOrdersCreate: clients.roomOrders.create.enqueue,
      evaluateRoomOrdersCreateRolloutGate: rolloutGateClient.evaluate,
      enqueueRoomOrdersNavigate: clients.roomOrders.navigate.enqueue,
      evaluateRoomOrdersNavigateRolloutGate: rolloutGateClient.evaluate,
      enqueueRoomOrdersSend: clients.roomOrders.send.enqueue,
      evaluateRoomOrdersSendRolloutGate: rolloutGateClient.evaluate,
      enqueueRoomOrdersPinTentative: clients.roomOrders.pinTentative.enqueue,
      evaluateRoomOrdersPinTentativeRolloutGate: rolloutGateClient.evaluate,
      enqueueSlotsDeliverList: clients.slots.deliverList.enqueue,
      evaluateSlotsDeliverListRolloutGate: rolloutGateClient.evaluate,
      enqueueSlotsPublishButton: clients.slots.publishButton.enqueue,
      evaluateSlotsPublishButtonRolloutGate: rolloutGateClient.evaluate,
      enqueueSlotsOpen: clients.slots.open.enqueue,
      evaluateSlotsOpenRolloutGate: rolloutGateClient.evaluate,
      enqueueMembersKick: clients.members.kick.enqueue,
      evaluateMembersKickRolloutGate: rolloutGateClient.evaluate,
      enqueuePreferencesDeliverStatus: clients.preferences.deliverStatus.enqueue,
      evaluatePreferencesDeliverStatusRolloutGate: rolloutGateClient.evaluate,
      enqueuePreferencesUpdateAndDeliver: clients.preferences.updateAndDeliver.enqueue,
      evaluatePreferencesUpdateAndDeliverRolloutGate: rolloutGateClient.evaluate,
      enqueueWorkspacesDeliverConfig: clients.workspaces.deliverConfig.enqueue,
      evaluateWorkspacesDeliverConfigRolloutGate: rolloutGateClient.evaluate,
      enqueueWorkspacesUpdateConfigAndDeliver: clients.workspaces.updateConfigAndDeliver.enqueue,
      evaluateWorkspacesUpdateConfigAndDeliverRolloutGate: rolloutGateClient.evaluate,
      enqueueWorkspacesSetMonitorRoleAndDeliver:
        clients.workspaces.setMonitorRoleAndDeliver.enqueue,
      evaluateWorkspacesSetMonitorRoleAndDeliverRolloutGate: rolloutGateClient.evaluate,
      enqueueWorkspacesFeatureFlagsSetAndDeliver:
        clients.workspaces.featureFlags.setAndDeliver.enqueue,
      evaluateWorkspacesFeatureFlagsSetAndDeliverRolloutGate: rolloutGateClient.evaluate,
      enqueueConversationsDeliverConfig: clients.conversations.deliverConfig.enqueue,
      evaluateConversationsDeliverConfigRolloutGate: rolloutGateClient.evaluate,
      enqueueConversationsUpdateConfigAndDeliver:
        clients.conversations.updateConfigAndDeliver.enqueue,
      evaluateConversationsUpdateConfigAndDeliverRolloutGate: rolloutGateClient.evaluate,
      enqueueConversationsSetLockdown: clients.conversations.setLockdown.enqueue,
      evaluateConversationsSetLockdownRolloutGate: rolloutGateClient.evaluate,
      enqueueTeamsDeliverList: clients.teams.deliverList.enqueue,
      evaluateTeamsDeliverListRolloutGate: rolloutGateClient.evaluate,
      enqueueScreenshotsCaptureAndDeliver: clients.screenshots.captureAndDeliver.enqueue,
      evaluateScreenshotsCaptureAndDeliverRolloutGate: rolloutGateClient.evaluate,
      enqueueWorkspacesDeliverWelcome: serviceClients.workspaces.deliverWelcome.enqueue,
      enqueueTeamSubmissionsProcess: serviceClients.teamSubmissions.process.enqueue,
      enqueueTeamSubmissionsDecide: clients.teamSubmissions.decide.enqueue,
      enqueueAnnouncementsDeliverUpdate: serviceClients.announcements.deliverUpdate.enqueue,
    } satisfies SheetWorkflowHttpClientShape;
  }),
}) {
  static layer = Layer.effect(SheetWorkflowHttpClient, this.make).pipe(
    Layer.provide(SheetAuthClient.layer),
  );
}

const enqueueWorkflow = <Input, Success, EnqueueError>(
  enqueue: (
    input: Input,
    options?: { readonly invocationId?: WorkflowInvocationId },
  ) => Effect.Effect<Success, EnqueueError, never>,
  input: Input,
  options?: { readonly invocationId?: WorkflowInvocationId },
) => {
  return (
    options?.invocationId === undefined
      ? makeWorkflowInvocationId()
      : Effect.succeed(options.invocationId)
  ).pipe(
    Effect.flatMap((invocationId) =>
      Effect.suspend(() => enqueue(input, { invocationId })).pipe(
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

export const enqueueStatusWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueServicesDeliverStatus">,
  input: ServicesDeliverStatusInput,
  options?: { readonly invocationId?: ServicesDeliverStatusReference["invocationId"] },
) => enqueueWorkflow(client.enqueueServicesDeliverStatus, input, options);

export const enqueueScheduleWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueSchedulesDeliverUserSchedule">,
  input: SchedulesDeliverUserScheduleInput,
  options?: { readonly invocationId?: SchedulesDeliverUserScheduleReference["invocationId"] },
) => enqueueWorkflow(client.enqueueSchedulesDeliverUserSchedule, input, options);

export const enqueueCheckinsOpenWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueCheckinsOpen">,
  input: CheckinsOpenInput,
  options?: { readonly invocationId?: CheckinsOpenReference["invocationId"] },
) => enqueueWorkflow(client.enqueueCheckinsOpen, input, options);

export const enqueueCheckinsTestAutoWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueCheckinsTestAuto">,
  input: CheckinsTestAutoInput,
  options?: { readonly invocationId?: CheckinsTestAutoReference["invocationId"] },
) => enqueueWorkflow(client.enqueueCheckinsTestAuto, input, options);

export const enqueueCheckinsRespondWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueCheckinsRespond">,
  input: CheckinsRespondInput,
  options?: { readonly invocationId?: CheckinsRespondReference["invocationId"] },
) => enqueueWorkflow(client.enqueueCheckinsRespond, input, options);

// fallow-ignore-next-line unused-export
export const enqueueRoomOrdersCreateWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueRoomOrdersCreate">,
  input: RoomOrdersCreateInput,
  options?: { readonly invocationId?: RoomOrdersCreateReference["invocationId"] },
) => enqueueWorkflow(client.enqueueRoomOrdersCreate, input, options);

// fallow-ignore-next-line unused-export
export const enqueueRoomOrdersNavigateWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueRoomOrdersNavigate">,
  input: RoomOrdersNavigateInput,
  options?: { readonly invocationId?: RoomOrdersNavigateReference["invocationId"] },
) => enqueueWorkflow(client.enqueueRoomOrdersNavigate, input, options);

// fallow-ignore-next-line unused-export
export const enqueueRoomOrdersSendWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueRoomOrdersSend">,
  input: RoomOrdersSendInput,
  options?: { readonly invocationId?: RoomOrdersSendReference["invocationId"] },
) => enqueueWorkflow(client.enqueueRoomOrdersSend, input, options);

// fallow-ignore-next-line unused-export
export const enqueueRoomOrdersPinTentativeWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueRoomOrdersPinTentative">,
  input: RoomOrdersPinTentativeInput,
  options?: { readonly invocationId?: RoomOrdersPinTentativeReference["invocationId"] },
) => enqueueWorkflow(client.enqueueRoomOrdersPinTentative, input, options);

export const enqueueSlotsDeliverListWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueSlotsDeliverList">,
  input: SlotsDeliverListInput,
  options?: { readonly invocationId?: SlotsDeliverListReference["invocationId"] },
) => enqueueWorkflow(client.enqueueSlotsDeliverList, input, options);

export const enqueueSlotsPublishButtonWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueSlotsPublishButton">,
  input: SlotsPublishButtonInput,
  options?: { readonly invocationId?: SlotsPublishButtonReference["invocationId"] },
) => enqueueWorkflow(client.enqueueSlotsPublishButton, input, options);

export const enqueueSlotsOpenWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueSlotsOpen">,
  input: SlotsOpenInput,
  options?: { readonly invocationId?: SlotsOpenReference["invocationId"] },
) => enqueueWorkflow(client.enqueueSlotsOpen, input, options);

// fallow-ignore-next-line unused-export
export const enqueueMembersKickWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueMembersKick">,
  input: MembersKickInput,
  options?: { readonly invocationId?: MembersKickReference["invocationId"] },
) => enqueueWorkflow(client.enqueueMembersKick, input, options);

export const enqueuePreferencesDeliverStatusWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueuePreferencesDeliverStatus">,
  input: PreferencesDeliverStatusInput,
  options?: { readonly invocationId?: PreferencesDeliverStatusReference["invocationId"] },
) => enqueueWorkflow(client.enqueuePreferencesDeliverStatus, input, options);

export const enqueuePreferencesUpdateAndDeliverWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueuePreferencesUpdateAndDeliver">,
  input: PreferencesUpdateAndDeliverInput,
  options?: { readonly invocationId?: PreferencesUpdateAndDeliverReference["invocationId"] },
) => enqueueWorkflow(client.enqueuePreferencesUpdateAndDeliver, input, options);

export const enqueueWorkspacesDeliverConfigWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueWorkspacesDeliverConfig">,
  input: WorkspacesDeliverConfigInput,
  options?: { readonly invocationId?: WorkspacesDeliverConfigReference["invocationId"] },
) => enqueueWorkflow(client.enqueueWorkspacesDeliverConfig, input, options);

export const enqueueWorkspacesUpdateConfigAndDeliverWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueWorkspacesUpdateConfigAndDeliver">,
  input: WorkspacesUpdateConfigAndDeliverInput,
  options?: {
    readonly invocationId?: WorkspacesUpdateConfigAndDeliverReference["invocationId"];
  },
) => enqueueWorkflow(client.enqueueWorkspacesUpdateConfigAndDeliver, input, options);

export const enqueueWorkspacesSetMonitorRoleAndDeliverWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueWorkspacesSetMonitorRoleAndDeliver">,
  input: WorkspacesSetMonitorRoleAndDeliverInput,
  options?: {
    readonly invocationId?: WorkspacesSetMonitorRoleAndDeliverReference["invocationId"];
  },
) => enqueueWorkflow(client.enqueueWorkspacesSetMonitorRoleAndDeliver, input, options);

// fallow-ignore-next-line unused-export
export const enqueueWorkspacesFeatureFlagsSetAndDeliverWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueWorkspacesFeatureFlagsSetAndDeliver">,
  input: WorkspacesFeatureFlagsSetAndDeliverInput,
  options?: {
    readonly invocationId?: WorkspacesFeatureFlagsSetAndDeliverReference["invocationId"];
  },
) => enqueueWorkflow(client.enqueueWorkspacesFeatureFlagsSetAndDeliver, input, options);

export const enqueueConversationsDeliverConfigWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueConversationsDeliverConfig">,
  input: ConversationsDeliverConfigInput,
  options?: { readonly invocationId?: ConversationsDeliverConfigReference["invocationId"] },
) => enqueueWorkflow(client.enqueueConversationsDeliverConfig, input, options);

export const enqueueConversationsUpdateConfigAndDeliverWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueConversationsUpdateConfigAndDeliver">,
  input: ConversationsUpdateConfigAndDeliverInput,
  options?: {
    readonly invocationId?: ConversationsUpdateConfigAndDeliverReference["invocationId"];
  },
) => enqueueWorkflow(client.enqueueConversationsUpdateConfigAndDeliver, input, options);

export const enqueueConversationsSetLockdownWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueConversationsSetLockdown">,
  input: ConversationsSetLockdownInput,
  options?: { readonly invocationId?: ConversationsSetLockdownReference["invocationId"] },
) => enqueueWorkflow(client.enqueueConversationsSetLockdown, input, options);

export const enqueueTeamsDeliverListWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueTeamsDeliverList">,
  input: TeamsDeliverListInput,
  options?: { readonly invocationId?: TeamsDeliverListReference["invocationId"] },
) => enqueueWorkflow(client.enqueueTeamsDeliverList, input, options);

// fallow-ignore-next-line unused-export
export const enqueueScreenshotsCaptureAndDeliverWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueScreenshotsCaptureAndDeliver">,
  input: ScreenshotsCaptureAndDeliverInput,
  options?: {
    readonly invocationId?: ScreenshotsCaptureAndDeliverReference["invocationId"];
  },
) => enqueueWorkflow(client.enqueueScreenshotsCaptureAndDeliver, input, options);

export const enqueueWorkspacesDeliverWelcomeWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueWorkspacesDeliverWelcome">,
  input: WorkspacesDeliverWelcomeInput,
  options?: { readonly invocationId?: WorkspacesDeliverWelcomeReference["invocationId"] },
) => enqueueWorkflow(client.enqueueWorkspacesDeliverWelcome, input, options);

export const enqueueTeamSubmissionsProcessWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueTeamSubmissionsProcess">,
  input: TeamSubmissionsProcessInput,
  options?: { readonly invocationId?: TeamSubmissionsProcessReference["invocationId"] },
) => enqueueWorkflow(client.enqueueTeamSubmissionsProcess, input, options);

export const enqueueTeamSubmissionsDecideWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueTeamSubmissionsDecide">,
  input: TeamSubmissionsDecideInput,
  options?: { readonly invocationId?: TeamSubmissionsDecideReference["invocationId"] },
) => enqueueWorkflow(client.enqueueTeamSubmissionsDecide, input, options);

export const enqueueAnnouncementsDeliverUpdateWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueAnnouncementsDeliverUpdate">,
  input: AnnouncementsDeliverUpdateInput,
  options?: { readonly invocationId?: AnnouncementsDeliverUpdateReference["invocationId"] },
) => enqueueWorkflow(client.enqueueAnnouncementsDeliverUpdate, input, options);
