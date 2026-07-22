import { Context, DateTime, Duration, Effect, Layer, Option, pipe } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { makeArgumentError } from "typhoon-core/error";
import type { WorkspaceConversationConfig } from "sheet-ingress-api/schemas/workspaceConfig";
import { checkinActionRow } from "sheet-message-content/components";
import {
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
import { resolveWorkspaceName } from "./dispatch/clients/workspace";
import * as MessageText from "sheet-message-content/text";
import { sendTentativeRoomOrder } from "./tentativeRoomOrder";
import {
  AutoCheckinConversationResult,
  AutoCheckinConversationWorkflow,
} from "@/workflows/autoCheckinContract";
import type { AutoCheckinConversationPayload } from "@/workflows/autoCheckinContract";
import { config } from "@/config";
import { deriveKickHour, makeKickRemover } from "./kick";

type WorkspaceMembers = Effect.Success<
  ReturnType<(typeof ClientDeliveryClient.Service)["getMembersForParent"]>
>;

type DeliveredMessage = {
  readonly id: string;
  readonly conversation_id: string;
};

type MessageKey = {
  readonly clientPlatform: string;
  readonly clientId: string;
  readonly messageId: string;
};

const messageKeyFor = (messageId: string): Effect.Effect<MessageKey> =>
  Effect.map(ClientDeliveryClientRef, (client) => ({
    clientPlatform: client.platform,
    clientId: client.clientId,
    messageId,
  }));

const deriveTargetHour = (eventStart: DateTime.DateTime, target: DateTime.DateTime): number => {
  const targetHourStart = pipe(target, DateTime.startOf("hour"));
  return Math.floor(Duration.toHours(DateTime.distance(eventStart, targetHourStart))) + 1;
};

const makeSheetApisServices = (sheetApisClient: typeof SheetApisClient.Service) => {
  const sheetApis = sheetApisClient.get();

  return {
    checkinService: {
      generate: (payload: {
        readonly workspaceId: string;
        readonly conversationName: string;
        readonly hour: number;
      }) =>
        sheetApis.checkin.generate({
          payload: {
            workspaceId: payload.workspaceId,
            conversationName: payload.conversationName,
            hour: payload.hour,
          },
        }),
    },
    userConfigService: {
      getCheckinDmRecipients: (platform: string, userIds: ReadonlyArray<string>) =>
        sheetApis.userConfig.getCheckinDmRecipients({
          payload: { platform, userIds: [...userIds] },
        }),
      getMonitorDmRecipients: (platform: string, userIds: ReadonlyArray<string>) =>
        sheetApis.userConfig.getMonitorDmRecipients({
          payload: { platform, userIds: [...userIds] },
        }),
    },
    workspaceConfigService: {
      getAutoCheckinWorkspaces: () => sheetApis.workspaceConfig.getAutoCheckinWorkspaces(),
      getWorkspaceConversations: (workspaceId: string, running: boolean) =>
        sheetApis.workspaceConfig.getWorkspaceConversations({ query: { workspaceId, running } }),
    },
    scheduleService: {
      conversationPopulatedMonitorSchedules: (workspaceId: string, conversationName: string) =>
        sheetApis.schedule
          .getConversationPopulatedSchedules({
            query: { workspaceId, conversationName, view: "monitor" },
          })
          .pipe(Effect.map(({ schedules }) => schedules)),
    },
    messageCheckinService: {
      persistMessageCheckin: (
        messageId: string,
        payload: Omit<
          Parameters<typeof sheetApis.messageCheckin.persistMessageCheckin>[0]["payload"],
          keyof MessageKey
        >,
      ) =>
        Effect.gen(function* () {
          const key = yield* messageKeyFor(messageId);
          return yield* sheetApis.messageCheckin.persistMessageCheckin({
            payload: { ...key, ...payload },
          });
        }),
    },
    messageRoomOrderService: {
      persistMessageRoomOrder: (
        messageId: string,
        payload: Omit<
          Parameters<typeof sheetApis.messageRoomOrder.persistMessageRoomOrder>[0]["payload"],
          keyof MessageKey
        >,
      ) =>
        Effect.gen(function* () {
          const key = yield* messageKeyFor(messageId);
          return yield* sheetApis.messageRoomOrder.persistMessageRoomOrder({
            payload: { ...key, ...payload },
          });
        }),
    },
    roomOrderService: {
      generate: (payload: {
        readonly workspaceId: string;
        readonly conversationId: string;
        readonly hour: number;
      }) =>
        sheetApis.roomOrder.generate({
          payload: {
            workspaceId: payload.workspaceId,
            conversationId: payload.conversationId,
            hour: payload.hour,
          },
        }),
    },
    sheetService: {
      getEventConfig: (workspaceId: string) =>
        sheetApis.sheet.getEventConfig({ query: { workspaceId } }),
    },
  };
};

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
          const initialMessage =
            generated.initialMessage === null
              ? null
              : MessageText.materializeGeneratedText(
                  client,
                  payload.workspaceId,
                  generated.initialMessage,
                );
          const monitorCheckinMessage = MessageText.materializeGeneratedText(
            client,
            payload.workspaceId,
            generated.monitorCheckinMessage,
          );
          const monitorFailureMessage =
            generated.monitorFailureMessage === null
              ? null
              : MessageText.materializeGeneratedText(
                  client,
                  payload.workspaceId,
                  generated.monitorFailureMessage,
                );

          let checkinMessage: DeliveredMessage | null = null;
          if (initialMessage !== null) {
            const formattedInitialMessage = formatAutoCheckinContent(initialMessage);
            checkinMessage = yield* botClient.sendMessage(generated.checkinConversationId, {
              content: formattedInitialMessage,
            });

            yield* messageCheckinService.persistMessageCheckin(checkinMessage.id, {
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
            });

            yield* botClient
              .updateMessage(checkinMessage.conversation_id, checkinMessage.id, {
                components: [checkinActionRow()],
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Failed to enable auto check-in message after persistence").pipe(
                    Effect.annotateLogs({
                      workspaceId: payload.workspaceId,
                      conversationName: payload.conversationName,
                      messageId: checkinMessage?.id ?? "unknown",
                    }),
                    Effect.andThen(Effect.logError(cause)),
                  ),
                ),
              );

            const workspaceName = yield* resolveWorkspaceName(botClient, payload.workspaceId);
            const openingDmWorkspace = Option.isSome(workspaceName)
              ? { workspaceName: workspaceName.value }
              : {};

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

            yield* sendMonitorCheckinOpeningDmPing({
              ...openingDmWorkspace,
              client,
              platform: client.platform,
              workspaceId: payload.workspaceId,
              runningConversationId: generated.runningConversationId,
              checkinConversationId: generated.checkinConversationId,
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
                    hour: generated.hour,
                  }),
                  Effect.andThen(Effect.logError(cause)),
                ),
              ),
            );
          }

          const monitorMessage = yield* botClient.sendMessage(
            generated.runningConversationId,
            autoCheckinSummaryMessage({
              monitorUserId: generated.monitorUserId,
              monitorCheckinMessage,
              monitorFailureMessage,
            }),
          );
          const tentativeRoomOrderMessage =
            initialMessage !== null
              ? yield* sendTentativeRoomOrder({
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
                })
              : null;

          return {
            workspaceId: payload.workspaceId,
            conversationName: payload.conversationName,
            hour: generated.hour,
            status: initialMessage !== null ? "sent" : "skipped",
            checkinMessageId: checkinMessage?.id ?? null,
            monitorMessageId: monitorMessage.id,
            tentativeRoomOrderMessageId: tentativeRoomOrderMessage?.messageId ?? null,
          } satisfies AutoCheckinConversationResult;
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
