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

const workflowHttpRequesterActorScopes = ["service", "token.exchange", "workflow.enqueue"] as const;

export type ServicesDeliverStatusEnqueue =
  SheetWorkflowHttpClients["services"]["deliverStatus"]["enqueue"];
export type ServicesDeliverStatusInput = Parameters<ServicesDeliverStatusEnqueue>[0];
export type ServicesDeliverStatusReference = Effect.Success<
  ReturnType<ServicesDeliverStatusEnqueue>
>;
export type SchedulesDeliverUserScheduleEnqueue =
  SheetWorkflowHttpClients["schedules"]["deliverUserSchedule"]["enqueue"];
export type SchedulesDeliverUserScheduleInput = Parameters<SchedulesDeliverUserScheduleEnqueue>[0];
export type SchedulesDeliverUserScheduleReference = Effect.Success<
  ReturnType<SchedulesDeliverUserScheduleEnqueue>
>;
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

export type SlotsRemoveButtonEnqueue = SheetWorkflowHttpClients["slots"]["removeButton"]["enqueue"];
export type SlotsRemoveButtonInput = Parameters<SlotsRemoveButtonEnqueue>[0];
export type SlotsRemoveButtonReference = Effect.Success<ReturnType<SlotsRemoveButtonEnqueue>>;
// fallow-ignore-next-line unused-type
export type SlotsRemoveButtonEnqueueError = Effect.Error<ReturnType<SlotsRemoveButtonEnqueue>>;

export type SlotsRefreshButtonEnqueue =
  SheetWorkflowHttpClients["slots"]["refreshButton"]["enqueue"];
export type SlotsRefreshButtonInput = Parameters<SlotsRefreshButtonEnqueue>[0];
export type SlotsRefreshButtonReference = Effect.Success<ReturnType<SlotsRefreshButtonEnqueue>>;
// fallow-ignore-next-line unused-type
export type SlotsRefreshButtonEnqueueError = Effect.Error<ReturnType<SlotsRefreshButtonEnqueue>>;

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

export type SheetConfigurationSaveDraftEnqueue =
  SheetWorkflowHttpClients["sheetConfiguration"]["saveDraft"]["enqueue"];
export type SheetConfigurationSaveDraftEnqueueInput =
  Parameters<SheetConfigurationSaveDraftEnqueue>[0];
export type SheetConfigurationSaveDraftReference = Effect.Success<
  ReturnType<SheetConfigurationSaveDraftEnqueue>
>;

export type SheetConfigurationEditDraftEnqueue =
  SheetWorkflowHttpClients["sheetConfiguration"]["editDraft"]["enqueue"];
export type SheetConfigurationEditDraftEnqueueInput =
  Parameters<SheetConfigurationEditDraftEnqueue>[0];
export type SheetConfigurationEditDraftReference = Effect.Success<
  ReturnType<SheetConfigurationEditDraftEnqueue>
>;

export type SheetConfigurationSaveRevisionEnqueue =
  SheetWorkflowHttpClients["sheetConfiguration"]["saveRevision"]["enqueue"];
export type SheetConfigurationSaveRevisionEnqueueInput =
  Parameters<SheetConfigurationSaveRevisionEnqueue>[0];
export type SheetConfigurationSaveRevisionReference = Effect.Success<
  ReturnType<SheetConfigurationSaveRevisionEnqueue>
>;

export type SheetConfigurationActivateEnqueue =
  SheetWorkflowHttpClients["sheetConfiguration"]["activate"]["enqueue"];
export type SheetConfigurationActivateEnqueueInput =
  Parameters<SheetConfigurationActivateEnqueue>[0];
export type SheetConfigurationActivateReference = Effect.Success<
  ReturnType<SheetConfigurationActivateEnqueue>
>;

export type SheetConfigurationRollbackEnqueue =
  SheetWorkflowHttpClients["sheetConfiguration"]["rollback"]["enqueue"];
export type SheetConfigurationRollbackEnqueueInput =
  Parameters<SheetConfigurationRollbackEnqueue>[0];
export type SheetConfigurationRollbackReference = Effect.Success<
  ReturnType<SheetConfigurationRollbackEnqueue>
>;

export type SheetConfigurationDiscardDraftEnqueue =
  SheetWorkflowHttpClients["sheetConfiguration"]["discardDraft"]["enqueue"];
export type SheetConfigurationDiscardDraftEnqueueInput =
  Parameters<SheetConfigurationDiscardDraftEnqueue>[0];
export type SheetConfigurationDiscardDraftReference = Effect.Success<
  ReturnType<SheetConfigurationDiscardDraftEnqueue>
>;

export type AuthorizationLoadWorkspaceCapabilitiesWorkflow =
  SheetWorkflowHttpClients["authorization"]["loadWorkspaceCapabilities"];

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
  readonly authorizationLoadWorkspaceCapabilities: AuthorizationLoadWorkspaceCapabilitiesWorkflow;
  readonly enqueueServicesDeliverStatus: ServicesDeliverStatusEnqueue;
  readonly enqueueSchedulesDeliverUserSchedule: SchedulesDeliverUserScheduleEnqueue;
  readonly enqueueCheckinsOpen: CheckinsOpenEnqueue;
  readonly enqueueCheckinsTestAuto: CheckinsTestAutoEnqueue;
  readonly enqueueCheckinsRespond: CheckinsRespondEnqueue;
  readonly enqueueRoomOrdersCreate: RoomOrdersCreateEnqueue;
  readonly enqueueRoomOrdersNavigate: RoomOrdersNavigateEnqueue;
  readonly enqueueRoomOrdersSend: RoomOrdersSendEnqueue;
  readonly enqueueRoomOrdersPinTentative: RoomOrdersPinTentativeEnqueue;
  readonly enqueueSlotsDeliverList: SlotsDeliverListEnqueue;
  readonly enqueueSlotsPublishButton: SlotsPublishButtonEnqueue;
  readonly enqueueSlotsRemoveButton: SlotsRemoveButtonEnqueue;
  readonly enqueueSlotsRefreshButton: SlotsRefreshButtonEnqueue;
  readonly enqueueSlotsOpen: SlotsOpenEnqueue;
  readonly enqueueMembersKick: MembersKickEnqueue;
  readonly enqueuePreferencesDeliverStatus: PreferencesDeliverStatusEnqueue;
  readonly enqueuePreferencesUpdateAndDeliver: PreferencesUpdateAndDeliverEnqueue;
  readonly enqueueWorkspacesDeliverConfig: WorkspacesDeliverConfigEnqueue;
  readonly enqueueWorkspacesUpdateConfigAndDeliver: WorkspacesUpdateConfigAndDeliverEnqueue;
  readonly enqueueWorkspacesSetMonitorRoleAndDeliver: WorkspacesSetMonitorRoleAndDeliverEnqueue;
  readonly enqueueWorkspacesFeatureFlagsSetAndDeliver: WorkspacesFeatureFlagsSetAndDeliverEnqueue;
  readonly enqueueConversationsDeliverConfig: ConversationsDeliverConfigEnqueue;
  readonly enqueueConversationsUpdateConfigAndDeliver: ConversationsUpdateConfigAndDeliverEnqueue;
  readonly enqueueConversationsSetLockdown: ConversationsSetLockdownEnqueue;
  readonly enqueueTeamsDeliverList: TeamsDeliverListEnqueue;
  readonly enqueueScreenshotsCaptureAndDeliver: ScreenshotsCaptureAndDeliverEnqueue;
  readonly enqueueWorkspacesDeliverWelcome: WorkspacesDeliverWelcomeEnqueue;
  readonly enqueueTeamSubmissionsProcess: TeamSubmissionsProcessEnqueue;
  readonly enqueueTeamSubmissionsDecide: TeamSubmissionsDecideEnqueue;
  readonly enqueueAnnouncementsDeliverUpdate: AnnouncementsDeliverUpdateEnqueue;
  readonly enqueueSheetConfigurationSaveDraft: SheetConfigurationSaveDraftEnqueue;
  readonly enqueueSheetConfigurationEditDraft: SheetConfigurationEditDraftEnqueue;
  readonly enqueueSheetConfigurationSaveRevision: SheetConfigurationSaveRevisionEnqueue;
  readonly enqueueSheetConfigurationActivate: SheetConfigurationActivateEnqueue;
  readonly enqueueSheetConfigurationRollback: SheetConfigurationRollbackEnqueue;
  readonly enqueueSheetConfigurationDiscardDraft: SheetConfigurationDiscardDraftEnqueue;
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

    return {
      authorizationLoadWorkspaceCapabilities: clients.authorization.loadWorkspaceCapabilities,
      enqueueServicesDeliverStatus: clients.services.deliverStatus.enqueue,
      enqueueSchedulesDeliverUserSchedule: clients.schedules.deliverUserSchedule.enqueue,
      enqueueCheckinsOpen: clients.checkins.open.enqueue,
      enqueueCheckinsTestAuto: clients.checkins.testAuto.enqueue,
      enqueueCheckinsRespond: clients.checkins.respond.enqueue,
      enqueueRoomOrdersCreate: clients.roomOrders.create.enqueue,
      enqueueRoomOrdersNavigate: clients.roomOrders.navigate.enqueue,
      enqueueRoomOrdersSend: clients.roomOrders.send.enqueue,
      enqueueRoomOrdersPinTentative: clients.roomOrders.pinTentative.enqueue,
      enqueueSlotsDeliverList: clients.slots.deliverList.enqueue,
      enqueueSlotsPublishButton: clients.slots.publishButton.enqueue,
      enqueueSlotsRemoveButton: clients.slots.removeButton.enqueue,
      enqueueSlotsRefreshButton: serviceClients.slots.refreshButton.enqueue,
      enqueueSlotsOpen: clients.slots.open.enqueue,
      enqueueMembersKick: clients.members.kick.enqueue,
      enqueuePreferencesDeliverStatus: clients.preferences.deliverStatus.enqueue,
      enqueuePreferencesUpdateAndDeliver: clients.preferences.updateAndDeliver.enqueue,
      enqueueWorkspacesDeliverConfig: clients.workspaces.deliverConfig.enqueue,
      enqueueWorkspacesUpdateConfigAndDeliver: clients.workspaces.updateConfigAndDeliver.enqueue,
      enqueueWorkspacesSetMonitorRoleAndDeliver:
        clients.workspaces.setMonitorRoleAndDeliver.enqueue,
      enqueueWorkspacesFeatureFlagsSetAndDeliver:
        clients.workspaces.featureFlags.setAndDeliver.enqueue,
      enqueueConversationsDeliverConfig: clients.conversations.deliverConfig.enqueue,
      enqueueConversationsUpdateConfigAndDeliver:
        clients.conversations.updateConfigAndDeliver.enqueue,
      enqueueConversationsSetLockdown: clients.conversations.setLockdown.enqueue,
      enqueueTeamsDeliverList: clients.teams.deliverList.enqueue,
      enqueueScreenshotsCaptureAndDeliver: clients.screenshots.captureAndDeliver.enqueue,
      enqueueWorkspacesDeliverWelcome: serviceClients.workspaces.deliverWelcome.enqueue,
      enqueueTeamSubmissionsProcess: serviceClients.teamSubmissions.process.enqueue,
      enqueueTeamSubmissionsDecide: clients.teamSubmissions.decide.enqueue,
      enqueueAnnouncementsDeliverUpdate: serviceClients.announcements.deliverUpdate.enqueue,
      enqueueSheetConfigurationSaveDraft: clients.sheetConfiguration.saveDraft.enqueue,
      enqueueSheetConfigurationEditDraft: clients.sheetConfiguration.editDraft.enqueue,
      enqueueSheetConfigurationSaveRevision: clients.sheetConfiguration.saveRevision.enqueue,
      enqueueSheetConfigurationActivate: clients.sheetConfiguration.activate.enqueue,
      enqueueSheetConfigurationRollback: clients.sheetConfiguration.rollback.enqueue,
      enqueueSheetConfigurationDiscardDraft: clients.sheetConfiguration.discardDraft.enqueue,
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

export const enqueueSheetConfigurationSaveDraftWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueSheetConfigurationSaveDraft">,
  input: SheetConfigurationSaveDraftEnqueueInput,
  options?: { readonly invocationId?: SheetConfigurationSaveDraftReference["invocationId"] },
) => enqueueWorkflow(client.enqueueSheetConfigurationSaveDraft, input, options);

export const enqueueSheetConfigurationEditDraftWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueSheetConfigurationEditDraft">,
  input: SheetConfigurationEditDraftEnqueueInput,
  options?: { readonly invocationId?: SheetConfigurationEditDraftReference["invocationId"] },
) => enqueueWorkflow(client.enqueueSheetConfigurationEditDraft, input, options);

export const enqueueSheetConfigurationSaveRevisionWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueSheetConfigurationSaveRevision">,
  input: SheetConfigurationSaveRevisionEnqueueInput,
  options?: {
    readonly invocationId?: SheetConfigurationSaveRevisionReference["invocationId"];
  },
) => enqueueWorkflow(client.enqueueSheetConfigurationSaveRevision, input, options);

export const enqueueSheetConfigurationActivateWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueSheetConfigurationActivate">,
  input: SheetConfigurationActivateEnqueueInput,
  options?: { readonly invocationId?: SheetConfigurationActivateReference["invocationId"] },
) => enqueueWorkflow(client.enqueueSheetConfigurationActivate, input, options);

export const enqueueSheetConfigurationRollbackWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueSheetConfigurationRollback">,
  input: SheetConfigurationRollbackEnqueueInput,
  options?: { readonly invocationId?: SheetConfigurationRollbackReference["invocationId"] },
) => enqueueWorkflow(client.enqueueSheetConfigurationRollback, input, options);

export const enqueueSheetConfigurationDiscardDraftWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueSheetConfigurationDiscardDraft">,
  input: SheetConfigurationDiscardDraftEnqueueInput,
  options?: {
    readonly invocationId?: SheetConfigurationDiscardDraftReference["invocationId"];
  },
) => enqueueWorkflow(client.enqueueSheetConfigurationDiscardDraft, input, options);

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

export const enqueueRoomOrdersCreateWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueRoomOrdersCreate">,
  input: RoomOrdersCreateInput,
  options?: { readonly invocationId?: RoomOrdersCreateReference["invocationId"] },
) => enqueueWorkflow(client.enqueueRoomOrdersCreate, input, options);

export const enqueueRoomOrdersNavigateWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueRoomOrdersNavigate">,
  input: RoomOrdersNavigateInput,
  options?: { readonly invocationId?: RoomOrdersNavigateReference["invocationId"] },
) => enqueueWorkflow(client.enqueueRoomOrdersNavigate, input, options);

export const enqueueRoomOrdersSendWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueRoomOrdersSend">,
  input: RoomOrdersSendInput,
  options?: { readonly invocationId?: RoomOrdersSendReference["invocationId"] },
) => enqueueWorkflow(client.enqueueRoomOrdersSend, input, options);

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

export const enqueueSlotsRemoveButtonWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueSlotsRemoveButton">,
  input: SlotsRemoveButtonInput,
  options?: { readonly invocationId?: SlotsRemoveButtonReference["invocationId"] },
) => enqueueWorkflow(client.enqueueSlotsRemoveButton, input, options);

export const enqueueSlotsRefreshButtonWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueSlotsRefreshButton">,
  input: SlotsRefreshButtonInput,
  options?: { readonly invocationId?: SlotsRefreshButtonReference["invocationId"] },
) => enqueueWorkflow(client.enqueueSlotsRefreshButton, input, options);

export const enqueueSlotsOpenWorkflow = (
  client: Pick<SheetWorkflowHttpClientShape, "enqueueSlotsOpen">,
  input: SlotsOpenInput,
  options?: { readonly invocationId?: SlotsOpenReference["invocationId"] },
) => enqueueWorkflow(client.enqueueSlotsOpen, input, options);

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
