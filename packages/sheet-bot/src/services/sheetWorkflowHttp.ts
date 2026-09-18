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
export const workflowHttpAudience = "sheet-workflows-http";
const workflowRequesterTokenCacheCapacity = 500;
const workflowEnqueueTimeout = Duration.seconds(30);

const workflowHttpRequesterActorScopes = [
  "service",
  "token.exchange",
  "workflow.enqueue",
  "workflow.observe",
] as const;

export type ServicesDeliverStatusEnqueue =
  SheetWorkflowHttpClients["services"]["deliverStatus"]["enqueue"];
export type ServicesDeliverStatusInput = Parameters<ServicesDeliverStatusEnqueue>[0];
export type ServicesDeliverStatusReference = Effect.Success<
  ReturnType<ServicesDeliverStatusEnqueue>
>;
export type SchedulesDeliverUserScheduleEnqueue =
  SheetWorkflowHttpClients["schedules"]["deliverUserSchedule"]["enqueue"];
export type SchedulesDeliverUserScheduleInput = Parameters<SchedulesDeliverUserScheduleEnqueue>[0];
export type SchedulesDeliverChannelFillersEnqueue =
  SheetWorkflowHttpClients["schedules"]["deliverChannelFillers"]["enqueue"];
export type SchedulesDeliverChannelFillersInput =
  Parameters<SchedulesDeliverChannelFillersEnqueue>[0];
export type CheckinsOpenEnqueue = SheetWorkflowHttpClients["checkins"]["open"]["enqueue"];
export type CheckinsOpenInput = Parameters<CheckinsOpenEnqueue>[0];
// fallow-ignore-next-line unused-type
export type CheckinsOpenEnqueueError = Effect.Error<ReturnType<CheckinsOpenEnqueue>>;

export type CheckinsTestAutoEnqueue = SheetWorkflowHttpClients["checkins"]["testAuto"]["enqueue"];
export type CheckinsTestAutoInput = Parameters<CheckinsTestAutoEnqueue>[0];
// fallow-ignore-next-line unused-type
export type CheckinsTestAutoEnqueueError = Effect.Error<ReturnType<CheckinsTestAutoEnqueue>>;

export type CheckinsRespondEnqueue = SheetWorkflowHttpClients["checkins"]["respond"]["enqueue"];
// fallow-ignore-next-line unused-type
export type CheckinsRespondEnqueueError = Effect.Error<ReturnType<CheckinsRespondEnqueue>>;

export type CheckinMessagesLoadWorkflow = SheetWorkflowHttpClients["checkinMessages"]["load"];
export type CheckinMessagesSaveWorkflow = SheetWorkflowHttpClients["checkinMessages"]["save"];

export type RoomOrdersCreateEnqueue = SheetWorkflowHttpClients["roomOrders"]["create"]["enqueue"];
export type RoomOrdersCreateInput = Parameters<RoomOrdersCreateEnqueue>[0];
// fallow-ignore-next-line unused-type
export type RoomOrdersCreateEnqueueError = Effect.Error<ReturnType<RoomOrdersCreateEnqueue>>;

export type RoomOrdersNavigateEnqueue =
  SheetWorkflowHttpClients["roomOrders"]["navigate"]["enqueue"];
// fallow-ignore-next-line unused-type
export type RoomOrdersNavigateEnqueueError = Effect.Error<ReturnType<RoomOrdersNavigateEnqueue>>;

export type RoomOrdersSendEnqueue = SheetWorkflowHttpClients["roomOrders"]["send"]["enqueue"];
// fallow-ignore-next-line unused-type
export type RoomOrdersSendEnqueueError = Effect.Error<ReturnType<RoomOrdersSendEnqueue>>;

export type RoomOrdersPinTentativeEnqueue =
  SheetWorkflowHttpClients["roomOrders"]["pinTentative"]["enqueue"];
// fallow-ignore-next-line unused-type
export type RoomOrdersPinTentativeEnqueueError = Effect.Error<
  ReturnType<RoomOrdersPinTentativeEnqueue>
>;

export type SlotsDeliverListEnqueue = SheetWorkflowHttpClients["slots"]["deliverList"]["enqueue"];
export type SlotsDeliverListInput = Parameters<SlotsDeliverListEnqueue>[0];
// fallow-ignore-next-line unused-type
export type SlotsDeliverListEnqueueError = Effect.Error<ReturnType<SlotsDeliverListEnqueue>>;

export type SlotsPublishButtonEnqueue =
  SheetWorkflowHttpClients["slots"]["publishButton"]["enqueue"];
export type SlotsPublishButtonInput = Parameters<SlotsPublishButtonEnqueue>[0];
// fallow-ignore-next-line unused-type
export type SlotsPublishButtonEnqueueError = Effect.Error<ReturnType<SlotsPublishButtonEnqueue>>;

export type SlotsRemoveButtonEnqueue = SheetWorkflowHttpClients["slots"]["removeButton"]["enqueue"];
export type SlotsRemoveButtonInput = Parameters<SlotsRemoveButtonEnqueue>[0];
// fallow-ignore-next-line unused-type
export type SlotsRemoveButtonEnqueueError = Effect.Error<ReturnType<SlotsRemoveButtonEnqueue>>;

export type SlotsRefreshButtonEnqueue =
  SheetWorkflowHttpClients["slots"]["refreshButton"]["enqueue"];
export type SlotsRefreshButtonInput = Parameters<SlotsRefreshButtonEnqueue>[0];
export type SlotsRefreshButtonReference = Effect.Success<ReturnType<SlotsRefreshButtonEnqueue>>;
// fallow-ignore-next-line unused-type
export type SlotsRefreshButtonEnqueueError = Effect.Error<ReturnType<SlotsRefreshButtonEnqueue>>;

export type SlotsOpenEnqueue = SheetWorkflowHttpClients["slots"]["open"]["enqueue"];
// fallow-ignore-next-line unused-type
export type SlotsOpenEnqueueError = Effect.Error<ReturnType<SlotsOpenEnqueue>>;

export type MembersKickEnqueue = SheetWorkflowHttpClients["members"]["kick"]["enqueue"];
export type MembersKickInput = Parameters<MembersKickEnqueue>[0];
// fallow-ignore-next-line unused-type
export type MembersKickEnqueueError = Effect.Error<ReturnType<MembersKickEnqueue>>;

export type PreferencesDeliverStatusEnqueue =
  SheetWorkflowHttpClients["preferences"]["deliverStatus"]["enqueue"];
export type PreferencesDeliverStatusInput = Parameters<PreferencesDeliverStatusEnqueue>[0];
// fallow-ignore-next-line unused-type
export type PreferencesDeliverStatusEnqueueError = Effect.Error<
  ReturnType<PreferencesDeliverStatusEnqueue>
>;

export type PreferencesUpdateAndDeliverEnqueue =
  SheetWorkflowHttpClients["preferences"]["updateAndDeliver"]["enqueue"];
export type PreferencesUpdateAndDeliverInput = Parameters<PreferencesUpdateAndDeliverEnqueue>[0];
// fallow-ignore-next-line unused-type
export type PreferencesUpdateAndDeliverEnqueueError = Effect.Error<
  ReturnType<PreferencesUpdateAndDeliverEnqueue>
>;

export type WorkspacesDeliverConfigEnqueue =
  SheetWorkflowHttpClients["workspaces"]["deliverConfig"]["enqueue"];
export type WorkspacesDeliverConfigInput = Parameters<WorkspacesDeliverConfigEnqueue>[0];
// fallow-ignore-next-line unused-type
export type WorkspacesDeliverConfigEnqueueError = Effect.Error<
  ReturnType<WorkspacesDeliverConfigEnqueue>
>;

export type WorkspacesUpdateConfigAndDeliverEnqueue =
  SheetWorkflowHttpClients["workspaces"]["updateConfigAndDeliver"]["enqueue"];
export type WorkspacesUpdateConfigAndDeliverInput =
  Parameters<WorkspacesUpdateConfigAndDeliverEnqueue>[0];
// fallow-ignore-next-line unused-type
export type WorkspacesUpdateConfigAndDeliverEnqueueError = Effect.Error<
  ReturnType<WorkspacesUpdateConfigAndDeliverEnqueue>
>;

export type WorkspacesSetMonitorRoleAndDeliverEnqueue =
  SheetWorkflowHttpClients["workspaces"]["setMonitorRoleAndDeliver"]["enqueue"];
export type WorkspacesSetMonitorRoleAndDeliverInput =
  Parameters<WorkspacesSetMonitorRoleAndDeliverEnqueue>[0];
// fallow-ignore-next-line unused-type
export type WorkspacesSetMonitorRoleAndDeliverEnqueueError = Effect.Error<
  ReturnType<WorkspacesSetMonitorRoleAndDeliverEnqueue>
>;

export type WorkspacesFeatureFlagsSetAndDeliverEnqueue =
  SheetWorkflowHttpClients["workspaces"]["featureFlags"]["setAndDeliver"]["enqueue"];
export type WorkspacesFeatureFlagsSetAndDeliverInput =
  Parameters<WorkspacesFeatureFlagsSetAndDeliverEnqueue>[0];
// fallow-ignore-next-line unused-type
export type WorkspacesFeatureFlagsSetAndDeliverEnqueueError = Effect.Error<
  ReturnType<WorkspacesFeatureFlagsSetAndDeliverEnqueue>
>;

export type ConversationsDeliverConfigEnqueue =
  SheetWorkflowHttpClients["conversations"]["deliverConfig"]["enqueue"];
export type ConversationsDeliverConfigInput = Parameters<ConversationsDeliverConfigEnqueue>[0];
// fallow-ignore-next-line unused-type
export type ConversationsDeliverConfigEnqueueError = Effect.Error<
  ReturnType<ConversationsDeliverConfigEnqueue>
>;

export type ConversationsUpdateConfigAndDeliverEnqueue =
  SheetWorkflowHttpClients["conversations"]["updateConfigAndDeliver"]["enqueue"];
export type ConversationsUpdateConfigAndDeliverInput =
  Parameters<ConversationsUpdateConfigAndDeliverEnqueue>[0];
// fallow-ignore-next-line unused-type
export type ConversationsUpdateConfigAndDeliverEnqueueError = Effect.Error<
  ReturnType<ConversationsUpdateConfigAndDeliverEnqueue>
>;

export type ConversationsSetLockdownEnqueue =
  SheetWorkflowHttpClients["conversations"]["setLockdown"]["enqueue"];
export type ConversationsSetLockdownInput = Parameters<ConversationsSetLockdownEnqueue>[0];
// fallow-ignore-next-line unused-type
export type ConversationsSetLockdownEnqueueError = Effect.Error<
  ReturnType<ConversationsSetLockdownEnqueue>
>;

export type TeamsDeliverListEnqueue = SheetWorkflowHttpClients["teams"]["deliverList"]["enqueue"];
export type TeamsDeliverListInput = Parameters<TeamsDeliverListEnqueue>[0];
// fallow-ignore-next-line unused-type
export type TeamsDeliverListEnqueueError = Effect.Error<ReturnType<TeamsDeliverListEnqueue>>;

export type ScreenshotsCaptureAndDeliverEnqueue =
  SheetWorkflowHttpClients["screenshots"]["captureAndDeliver"]["enqueue"];
export type ScreenshotsCaptureAndDeliverInput = Parameters<ScreenshotsCaptureAndDeliverEnqueue>[0];
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
export type SheetConfigurationEditDraftEnqueue =
  SheetWorkflowHttpClients["sheetConfiguration"]["editDraft"]["enqueue"];
export type SheetConfigurationSaveRevisionEnqueue =
  SheetWorkflowHttpClients["sheetConfiguration"]["saveRevision"]["enqueue"];
export type SheetConfigurationActivateEnqueue =
  SheetWorkflowHttpClients["sheetConfiguration"]["activate"]["enqueue"];
export type SheetConfigurationRollbackEnqueue =
  SheetWorkflowHttpClients["sheetConfiguration"]["rollback"]["enqueue"];
export type SheetConfigurationDiscardDraftEnqueue =
  SheetWorkflowHttpClients["sheetConfiguration"]["discardDraft"]["enqueue"];
export type AuthorizationLoadWorkspaceCapabilitiesWorkflow =
  SheetWorkflowHttpClients["authorization"]["loadWorkspaceCapabilities"];

type RawWorkflowEnqueue = (
  input: never,
  options?: { readonly invocationId?: WorkflowInvocationId },
) => Effect.Effect<unknown, unknown, never>;

type ProtectedWorkflowEnqueue<Enqueue extends RawWorkflowEnqueue> = (
  input: Parameters<Enqueue>[0],
  options?: { readonly invocationId?: WorkflowInvocationId },
) => ReturnType<Enqueue>;

type WorkflowEnqueueRecoveryPolicy = {
  readonly schedule: Schedule.Schedule<unknown, unknown, never, never>;
  readonly times?: number;
};

const standardWorkflowEnqueueRecoveryPolicy: WorkflowEnqueueRecoveryPolicy = {
  schedule: Schedule.spaced(Duration.millis(100)).pipe(Schedule.take(1)),
};

const workflowEnqueueRecoveryProfiles = {
  standard: undefined,
  gatewayDispatch: {
    schedule: Schedule.exponential(Duration.millis(100)),
    times: 2,
  },
  announcementDispatch: {
    schedule: Schedule.spaced(Duration.seconds(5)).pipe(Schedule.take(12)),
  },
} as const satisfies Record<
  "standard" | "gatewayDispatch" | "announcementDispatch",
  WorkflowEnqueueRecoveryPolicy | undefined
>;

type WorkflowEnqueueRecoveryProfile = keyof typeof workflowEnqueueRecoveryProfiles;

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

export const makeDiscordUserToken = Effect.fn("SheetWorkflowHttpClient.makeDiscordUserToken")(
  function* ({
    accessToken,
    audience,
    discordUserId,
    kubernetesServiceAccountTokenPath,
    sheetAuthClient,
    scope,
  }: {
    readonly accessToken: Redacted.Redacted<string>;
    readonly audience: string;
    readonly discordUserId: string;
    readonly kubernetesServiceAccountTokenPath: string;
    readonly sheetAuthClient: typeof SheetAuthClient.Service;
    readonly scope: readonly string[];
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
      audience,
      scope,
    });
  },
);

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

const isRetryableWorkflowTransport = (error: unknown) =>
  Predicate.isTagged("WorkflowTransportUnavailable")(error) &&
  Predicate.hasProperty("retryable")(error) &&
  Predicate.isBoolean(error.retryable) &&
  error.retryable;

const makeProtectedEnqueue = <Enqueue extends RawWorkflowEnqueue>(
  enqueue: Enqueue,
  recoveryProfile: WorkflowEnqueueRecoveryProfile = "standard",
): ProtectedWorkflowEnqueue<Enqueue> => {
  const protectedEnqueue = ((input, options) => {
    const invocationId =
      options?.invocationId === undefined
        ? makeWorkflowInvocationId()
        : Effect.succeed(options.invocationId);

    return invocationId.pipe(
      Effect.flatMap((stableInvocationId) => {
        const attempt = Effect.suspend(() =>
          enqueue(input, { invocationId: stableInvocationId }),
        ).pipe(
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
        );
        const standardRecovery = attempt.pipe(
          Effect.retry({
            ...standardWorkflowEnqueueRecoveryPolicy,
            while: isRetryableWorkflowTransport,
          }),
        );
        const profile = workflowEnqueueRecoveryProfiles[recoveryProfile];
        return profile === undefined
          ? standardRecovery
          : standardRecovery.pipe(
              Effect.retry({
                ...profile,
                while: isRetryableWorkflowTransport,
              }),
            );
      }),
    ) as ReturnType<Enqueue>;
  }) as ProtectedWorkflowEnqueue<Enqueue>;
  return protectedEnqueue;
};

export interface SheetWorkflowHttpClientShape {
  readonly authorizationLoadWorkspaceCapabilities: AuthorizationLoadWorkspaceCapabilitiesWorkflow;
  readonly enqueueServicesDeliverStatus: ProtectedWorkflowEnqueue<ServicesDeliverStatusEnqueue>;
  readonly enqueueSchedulesDeliverUserSchedule: ProtectedWorkflowEnqueue<SchedulesDeliverUserScheduleEnqueue>;
  readonly enqueueSchedulesDeliverChannelFillers: ProtectedWorkflowEnqueue<SchedulesDeliverChannelFillersEnqueue>;
  readonly enqueueCheckinsOpen: ProtectedWorkflowEnqueue<CheckinsOpenEnqueue>;
  readonly enqueueCheckinsTestAuto: ProtectedWorkflowEnqueue<CheckinsTestAutoEnqueue>;
  readonly enqueueCheckinsRespond: ProtectedWorkflowEnqueue<CheckinsRespondEnqueue>;
  readonly checkinMessagesLoad: CheckinMessagesLoadWorkflow;
  readonly checkinMessagesSave: CheckinMessagesSaveWorkflow;
  readonly enqueueRoomOrdersCreate: ProtectedWorkflowEnqueue<RoomOrdersCreateEnqueue>;
  readonly enqueueRoomOrdersNavigate: ProtectedWorkflowEnqueue<RoomOrdersNavigateEnqueue>;
  readonly enqueueRoomOrdersSend: ProtectedWorkflowEnqueue<RoomOrdersSendEnqueue>;
  readonly enqueueRoomOrdersPinTentative: ProtectedWorkflowEnqueue<RoomOrdersPinTentativeEnqueue>;
  readonly enqueueSlotsDeliverList: ProtectedWorkflowEnqueue<SlotsDeliverListEnqueue>;
  readonly enqueueSlotsPublishButton: ProtectedWorkflowEnqueue<SlotsPublishButtonEnqueue>;
  readonly enqueueSlotsRemoveButton: ProtectedWorkflowEnqueue<SlotsRemoveButtonEnqueue>;
  readonly enqueueSlotsRefreshButton: ProtectedWorkflowEnqueue<SlotsRefreshButtonEnqueue>;
  readonly enqueueSlotsOpen: ProtectedWorkflowEnqueue<SlotsOpenEnqueue>;
  readonly enqueueMembersKick: ProtectedWorkflowEnqueue<MembersKickEnqueue>;
  readonly enqueuePreferencesDeliverStatus: ProtectedWorkflowEnqueue<PreferencesDeliverStatusEnqueue>;
  readonly enqueuePreferencesUpdateAndDeliver: ProtectedWorkflowEnqueue<PreferencesUpdateAndDeliverEnqueue>;
  readonly enqueueWorkspacesDeliverConfig: ProtectedWorkflowEnqueue<WorkspacesDeliverConfigEnqueue>;
  readonly enqueueWorkspacesUpdateConfigAndDeliver: ProtectedWorkflowEnqueue<WorkspacesUpdateConfigAndDeliverEnqueue>;
  readonly enqueueWorkspacesSetMonitorRoleAndDeliver: ProtectedWorkflowEnqueue<WorkspacesSetMonitorRoleAndDeliverEnqueue>;
  readonly enqueueWorkspacesFeatureFlagsSetAndDeliver: ProtectedWorkflowEnqueue<WorkspacesFeatureFlagsSetAndDeliverEnqueue>;
  readonly enqueueConversationsDeliverConfig: ProtectedWorkflowEnqueue<ConversationsDeliverConfigEnqueue>;
  readonly enqueueConversationsUpdateConfigAndDeliver: ProtectedWorkflowEnqueue<ConversationsUpdateConfigAndDeliverEnqueue>;
  readonly enqueueConversationsSetLockdown: ProtectedWorkflowEnqueue<ConversationsSetLockdownEnqueue>;
  readonly enqueueTeamsDeliverList: ProtectedWorkflowEnqueue<TeamsDeliverListEnqueue>;
  readonly enqueueScreenshotsCaptureAndDeliver: ProtectedWorkflowEnqueue<ScreenshotsCaptureAndDeliverEnqueue>;
  readonly enqueueWorkspacesDeliverWelcome: ProtectedWorkflowEnqueue<WorkspacesDeliverWelcomeEnqueue>;
  readonly enqueueTeamSubmissionsProcess: ProtectedWorkflowEnqueue<TeamSubmissionsProcessEnqueue>;
  readonly enqueueTeamSubmissionsDecide: ProtectedWorkflowEnqueue<TeamSubmissionsDecideEnqueue>;
  readonly enqueueAnnouncementsDeliverUpdate: ProtectedWorkflowEnqueue<AnnouncementsDeliverUpdateEnqueue>;
  readonly enqueueSheetConfigurationSaveDraft: ProtectedWorkflowEnqueue<SheetConfigurationSaveDraftEnqueue>;
  readonly enqueueSheetConfigurationEditDraft: ProtectedWorkflowEnqueue<SheetConfigurationEditDraftEnqueue>;
  readonly enqueueSheetConfigurationSaveRevision: ProtectedWorkflowEnqueue<SheetConfigurationSaveRevisionEnqueue>;
  readonly enqueueSheetConfigurationActivate: ProtectedWorkflowEnqueue<SheetConfigurationActivateEnqueue>;
  readonly enqueueSheetConfigurationRollback: ProtectedWorkflowEnqueue<SheetConfigurationRollbackEnqueue>;
  readonly enqueueSheetConfigurationDiscardDraft: ProtectedWorkflowEnqueue<SheetConfigurationDiscardDraftEnqueue>;
}

export const makeSheetWorkflowHttpClientShape = (
  clients: SheetWorkflowHttpClients,
  serviceClients: SheetWorkflowHttpClients,
): SheetWorkflowHttpClientShape => ({
  authorizationLoadWorkspaceCapabilities: clients.authorization.loadWorkspaceCapabilities,
  enqueueServicesDeliverStatus: makeProtectedEnqueue(clients.services.deliverStatus.enqueue),
  enqueueSchedulesDeliverUserSchedule: makeProtectedEnqueue(
    clients.schedules.deliverUserSchedule.enqueue,
  ),
  enqueueSchedulesDeliverChannelFillers: makeProtectedEnqueue(
    clients.schedules.deliverChannelFillers.enqueue,
  ),
  enqueueCheckinsOpen: makeProtectedEnqueue(clients.checkins.open.enqueue),
  enqueueCheckinsTestAuto: makeProtectedEnqueue(clients.checkins.testAuto.enqueue),
  enqueueCheckinsRespond: makeProtectedEnqueue(clients.checkins.respond.enqueue),
  checkinMessagesLoad: clients.checkinMessages.load,
  checkinMessagesSave: clients.checkinMessages.save,
  enqueueRoomOrdersCreate: makeProtectedEnqueue(clients.roomOrders.create.enqueue),
  enqueueRoomOrdersNavigate: makeProtectedEnqueue(clients.roomOrders.navigate.enqueue),
  enqueueRoomOrdersSend: makeProtectedEnqueue(clients.roomOrders.send.enqueue),
  enqueueRoomOrdersPinTentative: makeProtectedEnqueue(clients.roomOrders.pinTentative.enqueue),
  enqueueSlotsDeliverList: makeProtectedEnqueue(clients.slots.deliverList.enqueue),
  enqueueSlotsPublishButton: makeProtectedEnqueue(clients.slots.publishButton.enqueue),
  enqueueSlotsRemoveButton: makeProtectedEnqueue(clients.slots.removeButton.enqueue),
  enqueueSlotsRefreshButton: makeProtectedEnqueue(
    serviceClients.slots.refreshButton.enqueue,
    "gatewayDispatch",
  ),
  enqueueSlotsOpen: makeProtectedEnqueue(clients.slots.open.enqueue),
  enqueueMembersKick: makeProtectedEnqueue(clients.members.kick.enqueue),
  enqueuePreferencesDeliverStatus: makeProtectedEnqueue(clients.preferences.deliverStatus.enqueue),
  enqueuePreferencesUpdateAndDeliver: makeProtectedEnqueue(
    clients.preferences.updateAndDeliver.enqueue,
  ),
  enqueueWorkspacesDeliverConfig: makeProtectedEnqueue(clients.workspaces.deliverConfig.enqueue),
  enqueueWorkspacesUpdateConfigAndDeliver: makeProtectedEnqueue(
    clients.workspaces.updateConfigAndDeliver.enqueue,
  ),
  enqueueWorkspacesSetMonitorRoleAndDeliver: makeProtectedEnqueue(
    clients.workspaces.setMonitorRoleAndDeliver.enqueue,
  ),
  enqueueWorkspacesFeatureFlagsSetAndDeliver: makeProtectedEnqueue(
    clients.workspaces.featureFlags.setAndDeliver.enqueue,
  ),
  enqueueConversationsDeliverConfig: makeProtectedEnqueue(
    clients.conversations.deliverConfig.enqueue,
  ),
  enqueueConversationsUpdateConfigAndDeliver: makeProtectedEnqueue(
    clients.conversations.updateConfigAndDeliver.enqueue,
  ),
  enqueueConversationsSetLockdown: makeProtectedEnqueue(clients.conversations.setLockdown.enqueue),
  enqueueTeamsDeliverList: makeProtectedEnqueue(clients.teams.deliverList.enqueue),
  enqueueScreenshotsCaptureAndDeliver: makeProtectedEnqueue(
    clients.screenshots.captureAndDeliver.enqueue,
  ),
  enqueueWorkspacesDeliverWelcome: makeProtectedEnqueue(
    serviceClients.workspaces.deliverWelcome.enqueue,
    "standard",
  ),
  enqueueTeamSubmissionsProcess: makeProtectedEnqueue(
    serviceClients.teamSubmissions.process.enqueue,
    "gatewayDispatch",
  ),
  enqueueTeamSubmissionsDecide: makeProtectedEnqueue(clients.teamSubmissions.decide.enqueue),
  enqueueAnnouncementsDeliverUpdate: makeProtectedEnqueue(
    serviceClients.announcements.deliverUpdate.enqueue,
    "announcementDispatch",
  ),
  enqueueSheetConfigurationSaveDraft: makeProtectedEnqueue(
    clients.sheetConfiguration.saveDraft.enqueue,
  ),
  enqueueSheetConfigurationEditDraft: makeProtectedEnqueue(
    clients.sheetConfiguration.editDraft.enqueue,
  ),
  enqueueSheetConfigurationSaveRevision: makeProtectedEnqueue(
    clients.sheetConfiguration.saveRevision.enqueue,
  ),
  enqueueSheetConfigurationActivate: makeProtectedEnqueue(
    clients.sheetConfiguration.activate.enqueue,
  ),
  enqueueSheetConfigurationRollback: makeProtectedEnqueue(
    clients.sheetConfiguration.rollback.enqueue,
  ),
  enqueueSheetConfigurationDiscardDraft: makeProtectedEnqueue(
    clients.sheetConfiguration.discardDraft.enqueue,
  ),
});

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
              audience: workflowHttpAudience,
              discordUserId,
              kubernetesServiceAccountTokenPath: subjectTokenKubernetesTokenPath,
              sheetAuthClient,
              scope: ["workflow.enqueue", "workflow.observe"],
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

    return makeSheetWorkflowHttpClientShape(clients, serviceClients);
  }),
}) {
  static layer = Layer.effect(SheetWorkflowHttpClient, this.make).pipe(
    Layer.provide(SheetAuthClient.layer),
  );
}
