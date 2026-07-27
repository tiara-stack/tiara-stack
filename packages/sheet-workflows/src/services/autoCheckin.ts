import { Context, DateTime, Duration, Effect, Layer, Option, Predicate, pipe } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { makeArgumentError } from "typhoon-core/error";
import type { WorkspaceConversationConfig } from "sheet-ingress-api/schemas/workspaceConfig";
import { generatingCheckinMessage } from "sheet-message-content/checkinPrompt";
import {
  autoMonitorCheckinDelivery,
  autoCheckinSummaryMessage,
  formatAutoCheckinContent,
} from "sheet-message-content/checkinSummary";
import { ClientDeliveryClient, ClientDeliveryClientRef } from "./clientDeliveryClient";
import {
  sendCheckinOpeningDmReminders,
  sendMonitorCheckinOpeningDmPing,
} from "./checkinDmReminders";
import { SheetApisClient } from "./sheetApisClient";
import { uniqueConversationNames } from "./autoCheckinConversations";
import { makeSheetApisServices as makeDispatchSheetApisServices } from "./dispatch/clients/sheetApis";
import { resolveWorkspaceName } from "./dispatch/clients/workspace";
import { deliverPersistedCheckinMessage } from "./dispatch/domain/checkinDelivery";
import { makeDeliveryNonce } from "./dispatch/pure/deliveryNonce";
import * as MessageText from "sheet-message-content/text";
import { sendTentativeRoomOrder } from "./tentativeRoomOrder";
import {
  AutoCheckinConversationResult,
  AutoCheckinConversationWorkflow,
  autoCheckinConversationIdempotencyKey,
} from "@/workflows/autoCheckinContract";
import type { AutoCheckinConversationPayload } from "@/workflows/autoCheckinContract";
import { config } from "@/config";
import { deriveKickHour, makeKickRemover } from "./kick";

type WorkspaceMembers = Effect.Success<
  ReturnType<(typeof ClientDeliveryClient.Service)["getMembersForParent"]>
>;

const deriveTargetHour = (eventStart: DateTime.DateTime, target: DateTime.DateTime): number => {
  const targetHourStart = pipe(target, DateTime.startOf("hour"));
  return Math.floor(Duration.toHours(DateTime.distance(eventStart, targetHourStart))) + 1;
};

const makeSheetApisServices = (sheetApisClient: typeof SheetApisClient.Service) => {
  const sheetApis = sheetApisClient.get();
  const {
    checkinService,
    messageCheckinService,
    messageRoomOrderService,
    roomOrderService,
    userConfigService,
    workspaceConfigService,
  } = makeDispatchSheetApisServices(sheetApisClient);

  return {
    checkinService,
    userConfigService,
    workspaceConfigService: {
      ...workspaceConfigService,
      getAutoCheckinWorkspaces: () => sheetApis.workspaceConfig.getAutoCheckinWorkspaces(),
    },
    scheduleService: {
      conversationPopulatedMonitorSchedules: (workspaceId: string, conversationName: string) =>
        sheetApis.schedule
          .getConversationPopulatedSchedules({
            query: { workspaceId, conversationName, view: "monitor" },
          })
          .pipe(Effect.map(({ schedules }) => schedules)),
    },
    messageCheckinService,
    messageRoomOrderService,
    roomOrderService,
    sheetService: {
      getEventConfig: (workspaceId: string) =>
        sheetApis.sheet.getEventConfig({ query: { workspaceId } }),
    },
  };
};

type SheetApisServices = ReturnType<typeof makeSheetApisServices>;
type GeneratedCheckin = Effect.Success<ReturnType<SheetApisServices["checkinService"]["generate"]>>;
type MaterializedText = ReturnType<typeof MessageText.materializeGeneratedText>;
type ResolvedWorkspaceName = Effect.Success<ReturnType<typeof resolveWorkspaceName>>;

const materializeCheckinMessages = (
  client: Parameters<typeof MessageText.materializeGeneratedText>[0],
  workspaceId: string,
  generated: GeneratedCheckin,
) => ({
  initialMessage:
    generated.initialMessage === null
      ? null
      : MessageText.materializeGeneratedText(client, workspaceId, generated.initialMessage),
  monitorCheckinMessage: MessageText.materializeGeneratedText(
    client,
    workspaceId,
    generated.monitorCheckinMessage,
  ),
  monitorFailureMessage:
    generated.monitorFailureMessage === null
      ? null
      : MessageText.materializeGeneratedText(client, workspaceId, generated.monitorFailureMessage),
});

const makeOpeningDmWorkspace = (workspaceName: ResolvedWorkspaceName) =>
  Option.match(workspaceName, {
    onNone: () => ({}),
    onSome: (name) => ({ workspaceName: name }),
  });

const deriveMonitorDeliveryPolicy = ({
  generated,
  initialMessage,
}: {
  readonly generated: GeneratedCheckin;
  readonly initialMessage: MaterializedText | null;
}) => {
  const hasMonitorConversation = Predicate.isNotNull(generated.monitorConversationId);
  const hasMonitorUser = Predicate.isNotNull(generated.monitorUserId);
  const sendConfiguredMonitorDm =
    hasMonitorConversation && generated.monitorCheckinRequired && hasMonitorUser;
  const sendLegacyMonitorDm =
    !hasMonitorConversation && Predicate.isNotNull(initialMessage) && hasMonitorUser;

  return {
    needsWorkspaceName:
      Predicate.isNotNull(initialMessage) || sendConfiguredMonitorDm || sendLegacyMonitorDm,
    sendConfiguredMonitorDm,
    sendLegacyMonitorDm,
  };
};

const deliverParticipantCheckin = Effect.fn("AutoCheckinService.deliverParticipantCheckin")(
  function* ({
    autoCheckinConcurrency,
    botClient,
    client,
    generated,
    initialMessage,
    messageCheckinService,
    openingDmWorkspace,
    payload,
    userConfigService,
  }: {
    readonly autoCheckinConcurrency: number;
    readonly botClient: typeof ClientDeliveryClient.Service;
    readonly client: Parameters<typeof MessageText.materializeGeneratedText>[0];
    readonly generated: GeneratedCheckin;
    readonly initialMessage: MaterializedText | null;
    readonly messageCheckinService: SheetApisServices["messageCheckinService"];
    readonly openingDmWorkspace: ReturnType<typeof makeOpeningDmWorkspace>;
    readonly payload: AutoCheckinConversationPayload;
    readonly userConfigService: SheetApisServices["userConfigService"];
  }) {
    if (initialMessage === null) {
      return null;
    }

    const formattedInitialMessage = formatAutoCheckinContent(initialMessage);
    const checkinMessage = yield* deliverPersistedCheckinMessage({
      botClient,
      checkinConversationId: generated.checkinConversationId,
      messageCheckinService,
      persistence: {
        data: {
          initialMessage: formattedInitialMessage,
          hour: generated.hour,
          runningConversationId: generated.runningConversationId,
          roleId: generated.roleId,
          workspaceId: payload.workspaceId,
          conversationId: generated.checkinConversationId,
          createdByUserId: null,
        },
        memberIds: generated.fillIds,
      },
      placeholderMessage: {
        ...generatingCheckinMessage(formattedInitialMessage),
        nonce: makeDeliveryNonce(autoCheckinConversationIdempotencyKey(payload)),
        enforceNonce: true,
      },
    });

    yield* sendCheckinOpeningDmReminders({
      ...openingDmWorkspace,
      client,
      platform: client.platform,
      workspaceId: payload.workspaceId,
      runningConversationId: generated.runningConversationId,
      checkinConversationId: generated.checkinConversationId,
      hour: generated.hour,
      fillIds: generated.fillIds,
      concurrency: autoCheckinConcurrency,
      userConfigService,
      botClient,
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Failed to process auto check-in opening DM reminders").pipe(
          Effect.annotateLogs({
            workspaceId: payload.workspaceId,
            conversationName: payload.conversationName,
            checkinConversationId: generated.checkinConversationId,
            hour: generated.hour,
          }),
          Effect.andThen(Effect.logError(cause)),
        ),
      ),
    );

    return checkinMessage;
  },
);

const deliverConfiguredMonitorMessage = Effect.fn(
  "AutoCheckinService.deliverConfiguredMonitorMessage",
)(function* ({
  botClient,
  delivery,
  hour,
  messageCheckinService,
  monitorConversationId,
  monitorUserId,
  payload,
  runningConversationId,
}: {
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly delivery: ReturnType<typeof autoMonitorCheckinDelivery>;
  readonly hour: number;
  readonly messageCheckinService: ReturnType<typeof makeSheetApisServices>["messageCheckinService"];
  readonly monitorConversationId: string;
  readonly monitorUserId: string | null;
  readonly payload: AutoCheckinConversationPayload;
  readonly runningConversationId: string;
}) {
  if (!delivery.checkinRequired || monitorUserId === null || delivery.message.content === null) {
    return yield* botClient.sendMessage(monitorConversationId, delivery.message);
  }

  const preparingMessage = generatingCheckinMessage(delivery.message.content);
  return yield* deliverPersistedCheckinMessage({
    botClient,
    checkinConversationId: monitorConversationId,
    messageCheckinService,
    persistence: {
      data: {
        initialMessage: delivery.message.content,
        hour,
        runningConversationId,
        roleId: null,
        workspaceId: payload.workspaceId,
        conversationId: monitorConversationId,
        createdByUserId: null,
      },
      memberIds: [monitorUserId],
    },
    placeholderMessage: {
      ...preparingMessage,
      embeds: delivery.message.embeds,
      allowedMentions: delivery.message.allowedMentions,
      nonce: makeDeliveryNonce(`${autoCheckinConversationIdempotencyKey(payload)}:monitor`),
      enforceNonce: true,
    },
  });
});

const deliverAutomaticMonitorSummary = Effect.fn(
  "AutoCheckinService.deliverAutomaticMonitorSummary",
)(function* ({
  botClient,
  client,
  generated,
  messageCheckinService,
  monitorCheckinMessage,
  monitorConversationId,
  monitorFailureMessage,
  payload,
}: {
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly client: Parameters<typeof MessageText.materializeGeneratedText>[0];
  readonly generated: GeneratedCheckin;
  readonly messageCheckinService: SheetApisServices["messageCheckinService"];
  readonly monitorCheckinMessage: MaterializedText;
  readonly monitorConversationId: string | null;
  readonly monitorFailureMessage: MaterializedText | null;
  readonly payload: AutoCheckinConversationPayload;
}) {
  if (monitorConversationId === null) {
    return yield* botClient.sendMessage(
      generated.runningConversationId,
      autoCheckinSummaryMessage({
        monitorUserId: generated.monitorUserId,
        monitorCheckinMessage,
        monitorFailureMessage,
      }),
    );
  }

  const delivery = autoMonitorCheckinDelivery({
    client,
    workspaceId: payload.workspaceId,
    runningConversationId: generated.runningConversationId,
    hour: generated.hour,
    monitorUserId: generated.monitorUserId,
    monitorCheckinRequired: generated.monitorCheckinRequired,
    monitorCheckinMessage,
    monitorFailureMessage,
  });

  return yield* deliverConfiguredMonitorMessage({
    botClient,
    delivery,
    hour: generated.hour,
    messageCheckinService,
    monitorConversationId,
    monitorUserId: generated.monitorUserId,
    payload,
    runningConversationId: generated.runningConversationId,
  });
});

const sendAutomaticMonitorDm = Effect.fn("AutoCheckinService.sendAutomaticMonitorDm")(function* ({
  autoCheckinConcurrency,
  botClient,
  client,
  configured,
  generated,
  monitorConversationId,
  openingDmWorkspace,
  payload,
  userConfigService,
}: {
  readonly autoCheckinConcurrency: number;
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly client: Parameters<typeof MessageText.materializeGeneratedText>[0];
  readonly configured: boolean;
  readonly generated: GeneratedCheckin;
  readonly monitorConversationId: string | null;
  readonly openingDmWorkspace: ReturnType<typeof makeOpeningDmWorkspace>;
  readonly payload: AutoCheckinConversationPayload;
  readonly userConfigService: SheetApisServices["userConfigService"];
}) {
  yield* sendMonitorCheckinOpeningDmPing({
    ...openingDmWorkspace,
    client,
    platform: client.platform,
    workspaceId: payload.workspaceId,
    runningConversationId: generated.runningConversationId,
    checkinConversationId: generated.checkinConversationId,
    ...(configured && monitorConversationId !== null ? { monitorConversationId } : {}),
    hour: generated.hour,
    monitorUserId: generated.monitorUserId,
    concurrency: autoCheckinConcurrency,
    userConfigService,
    botClient,
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Failed to process auto check-in monitor DM ping").pipe(
        Effect.annotateLogs({
          workspaceId: payload.workspaceId,
          conversationName: payload.conversationName,
          checkinConversationId: generated.checkinConversationId,
          monitorConversationId,
          hour: generated.hour,
        }),
        Effect.andThen(Effect.logError(cause)),
      ),
    ),
  );
});

const sendAutomaticTentativeRoomOrder = Effect.fn(
  "AutoCheckinService.sendAutomaticTentativeRoomOrder",
)(function* ({
  botClient,
  client,
  generated,
  initialMessage,
  messageRoomOrderService,
  payload,
  roomOrderService,
}: {
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly client: Parameters<typeof MessageText.materializeGeneratedText>[0];
  readonly generated: GeneratedCheckin;
  readonly initialMessage: MaterializedText | null;
  readonly messageRoomOrderService: SheetApisServices["messageRoomOrderService"];
  readonly payload: AutoCheckinConversationPayload;
  readonly roomOrderService: SheetApisServices["roomOrderService"];
}) {
  if (initialMessage === null) {
    return null;
  }

  return yield* sendTentativeRoomOrder({
    workspaceId: payload.workspaceId,
    runningConversationId: generated.runningConversationId,
    hour: generated.hour,
    fillCount: generated.fillCount,
    createdByUserId: null,
    client,
    botClient,
    roomOrderService,
    messageRoomOrderService,
    logPrefix: "auto check-in",
  });
});

const makeAutoCheckinConversationResult = ({
  checkinMessageId,
  conversationName,
  hour,
  initialMessage,
  monitorMessageId,
  tentativeRoomOrderMessageId,
  workspaceId,
}: {
  readonly checkinMessageId: string | null;
  readonly conversationName: string;
  readonly hour: number;
  readonly initialMessage: MaterializedText | null;
  readonly monitorMessageId: string;
  readonly tentativeRoomOrderMessageId: string | null;
  readonly workspaceId: string;
}): AutoCheckinConversationResult => ({
  workspaceId,
  conversationName,
  hour,
  status: Predicate.isNotNull(initialMessage) ? "sent" : "skipped",
  checkinMessageId,
  monitorMessageId,
  tentativeRoomOrderMessageId,
});

export class AutoCheckinWorkflowClient extends Context.Service<AutoCheckinWorkflowClient>()(
  "AutoCheckinWorkflowClient",
  {
    make: Effect.succeed({
      enqueueConversation: Effect.fn("AutoCheckinWorkflowClient.enqueueConversation")(
        (payload: AutoCheckinConversationPayload) =>
          AutoCheckinConversationWorkflow.execute(payload, { discard: true }).pipe(
            Effect.withSpan("AutoCheckinWorkflowClient.enqueueConversation", {
              attributes: {
                workspaceId: payload.workspaceId,
                conversationName: payload.conversationName,
                hour: payload.hour,
              },
            }),
          ),
      ),
    }).pipe(
      Effect.andThen((service) =>
        Effect.gen(function* () {
          const workflowEngine = yield* WorkflowEngine.WorkflowEngine;
          return {
            enqueueConversation: (payload: AutoCheckinConversationPayload) =>
              service
                .enqueueConversation(payload)
                .pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine)),
          };
        }),
      ),
    ),
  },
) {
  static layer = Layer.effect(AutoCheckinWorkflowClient, this.make);
}

export class AutoCheckinService extends Context.Service<AutoCheckinService>()(
  "AutoCheckinService",
  {
    make: Effect.gen(function* () {
      const botClient = yield* ClientDeliveryClient;
      const sheetApisClient = yield* SheetApisClient;
      const workflowClient = yield* AutoCheckinWorkflowClient;
      const autoCheckinConcurrency = yield* config.autoCheckinConcurrency;
      const autoKickConcurrency = yield* config.autoKickConcurrency;
      const {
        checkinService,
        userConfigService,
        workspaceConfigService,
        messageCheckinService,
        messageRoomOrderService,
        roomOrderService,
        scheduleService,
        sheetService,
      } = makeSheetApisServices(sheetApisClient);
      const removeKickMembers = makeKickRemover({
        botClient,
        removalConcurrency: autoKickConcurrency,
        scheduleService,
      });

      const enqueueWorkspace = Effect.fn("AutoCheckinService.enqueueWorkspace")(function* (
        workspaceId: string,
      ) {
        yield* Effect.annotateCurrentSpan({ workspaceId, autoCheckinConcurrency });
        const eventConfig = yield* sheetService.getEventConfig(workspaceId);
        const targetDateTime = yield* DateTime.now.pipe(
          Effect.map(DateTime.addDuration("20 minutes")),
        );
        const hour = deriveTargetHour(eventConfig.startTime, targetDateTime);
        const eventStartEpochMs = DateTime.toEpochMillis(eventConfig.startTime);
        const conversations = yield* workspaceConfigService.getWorkspaceConversations(
          workspaceId,
          true,
        );
        const conversationNames = uniqueConversationNames(conversations);

        const results = yield* Effect.forEach(
          conversationNames,
          (conversationName) =>
            workflowClient
              .enqueueConversation({
                workspaceId,
                conversationName,
                hour,
                eventStartEpochMs,
              })
              .pipe(
                Effect.as(1),
                Effect.catchCause((cause) =>
                  Effect.logError("Failed to enqueue auto check-in conversation workflow").pipe(
                    Effect.annotateLogs({ workspaceId, conversationName, hour }),
                    Effect.andThen(Effect.logError(cause)),
                    Effect.as(0),
                  ),
                ),
              ),
          { concurrency: autoCheckinConcurrency },
        );

        const enqueuedCount = results.reduce((sum, count) => sum + count, 0);
        yield* Effect.annotateCurrentSpan({ enqueuedConversationCount: enqueuedCount, hour });
        return enqueuedCount;
      });

      const kickConversation = Effect.fn("AutoCheckinService.kickConversation")(function* (
        workspaceId: string,
        hour: number,
        conversation: WorkspaceConversationConfig,
        members: WorkspaceMembers,
      ) {
        return yield* Option.match(conversation.roleId, {
          onNone: () => Effect.succeed(0),
          onSome: (roleId) =>
            Option.match(conversation.name, {
              onNone: () =>
                Effect.logWarning("Skipping auto-kick for unnamed conversation").pipe(
                  Effect.annotateLogs({
                    workspaceId,
                    runningConversationId: conversation.conversationId,
                    hour,
                    roleId,
                  }),
                  Effect.as(0),
                ),
              onSome: (conversationName) =>
                removeKickMembers({
                  workspaceId,
                  runningConversationId: conversation.conversationId,
                  conversationName,
                  roleId,
                  hour,
                  members,
                }).pipe(
                  Effect.tap((result) =>
                    Effect.logInfo("Completed automatic lockdown-role cleanup").pipe(
                      Effect.annotateLogs({
                        workspaceId,
                        runningConversationId: conversation.conversationId,
                        conversationName,
                        roleId,
                        hour,
                        scheduleFound: result.scheduleFound,
                        removedCount: result.removedMemberIds.length,
                        failedCount: result.failedMemberIds.length,
                      }),
                    ),
                  ),
                  Effect.as(1),
                  Effect.catchCause((cause) =>
                    Effect.logError("Failed automatic lockdown-role cleanup").pipe(
                      Effect.annotateLogs({
                        workspaceId,
                        runningConversationId: conversation.conversationId,
                        conversationName,
                        roleId,
                        hour,
                      }),
                      Effect.andThen(Effect.logError(cause)),
                      Effect.as(0),
                    ),
                  ),
                ),
            }),
        });
      });

      const kickWorkspace = Effect.fn("AutoCheckinService.kickWorkspace")(function* (
        workspaceId: string,
      ) {
        const date = yield* DateTime.now;
        const eventConfig = yield* sheetService.getEventConfig(workspaceId);
        const hour = deriveKickHour(eventConfig.startTime, date);
        yield* Effect.annotateCurrentSpan({ workspaceId, hour, autoKickConcurrency });
        const conversations = yield* workspaceConfigService.getWorkspaceConversations(
          workspaceId,
          true,
        );
        const managedConversations = conversations.filter((conversation) =>
          Option.isSome(conversation.roleId),
        );
        if (managedConversations.length === 0) {
          return 0;
        }
        const members = yield* botClient.getMembersForParent(workspaceId);
        const counts = yield* Effect.forEach(
          managedConversations,
          (conversation) => kickConversation(workspaceId, hour, conversation, members),
          { concurrency: 1 },
        );
        const processedCount = counts.reduce((sum, count) => sum + count, 0);
        yield* Effect.annotateCurrentSpan({ processedConversationCount: processedCount });
        return processedCount;
      });

      return {
        enqueueWorkspace,
        kickWorkspace,
        enqueueDueConversations: Effect.fn("AutoCheckinService.enqueueDueConversations")(
          function* () {
            yield* Effect.annotateCurrentSpan({ autoCheckinConcurrency });
            const workspaceConfigs = yield* workspaceConfigService.getAutoCheckinWorkspaces();
            const counts = yield* Effect.forEach(
              workspaceConfigs,
              (workspaceConfig) =>
                enqueueWorkspace(workspaceConfig.workspaceId).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logError("Failed to enqueue auto check-in workspace").pipe(
                      Effect.annotateLogs({ workspaceId: workspaceConfig.workspaceId }),
                      Effect.andThen(Effect.logError(cause)),
                      Effect.as(0),
                    ),
                  ),
                ),
              { concurrency: autoCheckinConcurrency },
            );

            const enqueuedCount = counts.reduce((sum, count) => sum + count, 0);
            yield* Effect.annotateCurrentSpan({
              workspaceCount: workspaceConfigs.length,
              enqueuedConversationCount: enqueuedCount,
            });
            return enqueuedCount;
          },
        ),
        runDueKicks: Effect.fn("AutoCheckinService.runDueKicks")(function* () {
          yield* Effect.annotateCurrentSpan({ autoKickConcurrency });
          const workspaceConfigs = yield* workspaceConfigService.getAutoCheckinWorkspaces();
          const counts = yield* Effect.forEach(
            workspaceConfigs,
            (workspaceConfig) =>
              kickWorkspace(workspaceConfig.workspaceId).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Failed automatic lockdown-role cleanup for workspace").pipe(
                    Effect.annotateLogs({ workspaceId: workspaceConfig.workspaceId }),
                    Effect.andThen(Effect.logError(cause)),
                    Effect.as(0),
                  ),
                ),
              ),
            { concurrency: 1 },
          );
          const processedCount = counts.reduce((sum, count) => sum + count, 0);
          yield* Effect.annotateCurrentSpan({
            workspaceCount: workspaceConfigs.length,
            processedConversationCount: processedCount,
          });
          return processedCount;
        }),
        processConversation: Effect.fn("AutoCheckinService.processConversation")(function* (
          payload: AutoCheckinConversationPayload,
        ) {
          yield* Effect.annotateCurrentSpan({
            workspaceId: payload.workspaceId,
            conversationName: payload.conversationName,
            hour: payload.hour,
          });
          if (payload.conversationName.length === 0) {
            return yield* Effect.fail(
              makeArgumentError("Cannot auto check-in an unnamed conversation"),
            );
          }

          const generated = yield* checkinService.generate({
            workspaceId: payload.workspaceId,
            conversationName: payload.conversationName,
            hour: payload.hour,
          });
          const client = yield* ClientDeliveryClientRef;
          const { initialMessage, monitorCheckinMessage, monitorFailureMessage } =
            materializeCheckinMessages(client, payload.workspaceId, generated);
          const monitorConversationId = generated.monitorConversationId;
          const monitorDeliveryPolicy = deriveMonitorDeliveryPolicy({
            generated,
            initialMessage,
          });
          const workspaceName = monitorDeliveryPolicy.needsWorkspaceName
            ? yield* resolveWorkspaceName(botClient, payload.workspaceId)
            : Option.none<string>();
          const openingDmWorkspace = makeOpeningDmWorkspace(workspaceName);

          const checkinMessage = yield* deliverParticipantCheckin({
            autoCheckinConcurrency,
            botClient,
            client,
            generated,
            initialMessage,
            messageCheckinService,
            openingDmWorkspace,
            payload,
            userConfigService,
          });

          if (monitorDeliveryPolicy.sendLegacyMonitorDm) {
            yield* sendAutomaticMonitorDm({
              autoCheckinConcurrency,
              botClient,
              client,
              configured: false,
              generated,
              monitorConversationId,
              openingDmWorkspace,
              payload,
              userConfigService,
            });
          }

          const monitorMessage = yield* deliverAutomaticMonitorSummary({
            botClient,
            client,
            generated,
            messageCheckinService,
            monitorCheckinMessage,
            monitorConversationId,
            monitorFailureMessage,
            payload,
          });

          if (monitorDeliveryPolicy.sendConfiguredMonitorDm) {
            yield* sendAutomaticMonitorDm({
              autoCheckinConcurrency,
              botClient,
              client,
              configured: true,
              generated,
              monitorConversationId,
              openingDmWorkspace,
              payload,
              userConfigService,
            });
          }
          const tentativeRoomOrderMessage = yield* sendAutomaticTentativeRoomOrder({
            botClient,
            client,
            generated,
            initialMessage,
            messageRoomOrderService,
            payload,
            roomOrderService,
          });

          return makeAutoCheckinConversationResult({
            workspaceId: payload.workspaceId,
            conversationName: payload.conversationName,
            hour: generated.hour,
            checkinMessageId: checkinMessage?.id ?? null,
            monitorMessageId: monitorMessage.id,
            tentativeRoomOrderMessageId: tentativeRoomOrderMessage?.messageId ?? null,
            initialMessage,
          });
        }),
      };
    }),
  },
) {
  static layer = Layer.effect(AutoCheckinService, this.make).pipe(
    Layer.provide([
      AutoCheckinWorkflowClient.layer,
      ClientDeliveryClient.layer,
      SheetApisClient.layer,
    ]),
  );
}
