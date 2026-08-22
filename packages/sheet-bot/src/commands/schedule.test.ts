import { describe, expect, it, layer } from "@effect/vitest";
import { Ix } from "dfx";
import type { APIChatInputApplicationCommandInteraction } from "dfx/types";
import { InteractionToken } from "dfx-discord-utils/utils";
import {
  ApplicationCommandType,
  ChannelType,
  InteractionType,
  Locale,
} from "discord-api-types/v10";
import { ConfigProvider, Duration, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import type { CommandInteractionResponseContext } from "dfx-discord-utils/utils";
import { ResponseReference } from "sheet-bot-api/references";
import { WorkflowInputRejected, WorkflowTransportUnavailable } from "sheet-workflow-http-client";
import {
  BotCapabilityStore,
  type SheetWorkflowHttpClientShape,
  type SheetWorkflowsClientShape,
  type SchedulesDeliverUserScheduleReference,
} from "../services";
import { enqueueSchedule, makeScheduleResponseReferenceInput } from "./schedule";

type ScheduleTestWorkflowClient = Pick<
  SheetWorkflowHttpClientShape,
  "enqueueSchedulesDeliverUserSchedule" | "evaluateScheduleRolloutGate"
>;
type ScheduleEnqueueOptions = Parameters<
  ScheduleTestWorkflowClient["enqueueSchedulesDeliverUserSchedule"]
>[1];
type ScheduleEnqueueInput = Parameters<
  ScheduleTestWorkflowClient["enqueueSchedulesDeliverUserSchedule"]
>[0];
type ScheduleGateEvaluationInput = Parameters<
  ScheduleTestWorkflowClient["evaluateScheduleRolloutGate"]
>[0];
type ScheduleGateEvaluation = (
  input: ScheduleGateEvaluationInput,
) => Effect.Effect<unknown, unknown, never>;

const replacementScheduleRolloutGateDecision = {
  gateKey: "gate-key",
  revision: 1,
  matched: true,
  executionPath: "replacement" as const,
  reason: "replacement-enabled",
};

const scheduleInput = {
  workspaceId: Schema.decodeUnknownSync(
    Schema.Trimmed.check(Schema.isNonEmpty()).pipe(
      Schema.brand("sheet-workflow-contracts/WorkspaceId"),
    ),
  )("workspace-1"),
  day: 2,
  targetUserId: "target-user-1",
  targetUsername: "Target_User",
} as const;

const makeScheduleCapabilityStore = (onIssueResponseReference: () => void = () => {}) => {
  const responseReference = Schema.decodeUnknownSync(ResponseReference)(
    "opaque-response-reference",
  );
  return {
    issueResponseReference: () => {
      onIssueResponseReference();
      return Effect.succeed(responseReference);
    },
  } as Pick<typeof BotCapabilityStore.Service, "issueResponseReference">;
};

const makeScheduleWorkflowClient = <Success, EnqueueError>(
  enqueueSchedulesDeliverUserSchedule: (
    input: ScheduleEnqueueInput,
    options?: ScheduleEnqueueOptions,
  ) => Effect.Effect<Success, EnqueueError, never>,
  evaluateScheduleRolloutGate: ScheduleGateEvaluation = () =>
    Effect.succeed(replacementScheduleRolloutGateDecision),
): ScheduleTestWorkflowClient => ({
  evaluateScheduleRolloutGate:
    evaluateScheduleRolloutGate as unknown as ScheduleTestWorkflowClient["evaluateScheduleRolloutGate"],
  enqueueSchedulesDeliverUserSchedule:
    enqueueSchedulesDeliverUserSchedule as unknown as ScheduleTestWorkflowClient["enqueueSchedulesDeliverUserSchedule"],
});

const makeScheduleSheetWorkflowsClient = (
  onLegacyDispatch: () => void,
  scheduleList: () => Effect.Effect<unknown, unknown, never> = () => Effect.succeed({}),
): SheetWorkflowsClientShape =>
  ({
    get: () => ({
      dispatch: {
        scheduleList: () => {
          onLegacyDispatch();
          return scheduleList();
        },
      },
    }),
  }) as unknown as SheetWorkflowsClientShape;

const scheduleEnqueueLayer = Layer.mergeAll(
  Layer.succeed(InteractionToken, {
    applicationId: "application-1",
    token: "interaction-token",
  }),
  ConfigProvider.layer(ConfigProvider.fromUnknown({ SHEET_BOT_CLIENT_ID: "discord-main" })),
);

const makeScheduleInteraction = (
  guildId = "workspace-1",
): APIChatInputApplicationCommandInteraction => ({
  id: "123456789012345678",
  application_id: "application-1",
  type: InteractionType.ApplicationCommand,
  data: {
    id: "command-1",
    name: "schedule",
    type: ApplicationCommandType.ChatInput,
  },
  user: {
    id: "discord-user-1",
    username: "schedule-user",
    discriminator: "0001",
    global_name: "schedule-user",
    avatar: null,
  },
  channel_id: "channel-1",
  channel: { id: "channel-1", type: ChannelType.GuildText },
  token: "interaction-token",
  version: 1,
  app_permissions: "0",
  locale: Locale.EnglishUS,
  entitlements: [],
  authorizing_integration_owners: {},
  attachment_size_limit: 8_000_000,
  guild: { id: guildId, features: [], locale: Locale.EnglishUS },
});

const makeResponse = (messages: Array<string | undefined>) =>
  ({
    editReply: ({ payload }: { readonly payload: { readonly content?: string } }) => {
      messages.push(payload.content);
      return Effect.void;
    },
  }) as Pick<CommandInteractionResponseContext, "editReply">;

const runScheduleEnqueue = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: ScheduleTestWorkflowClient,
  capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
) =>
  enqueueSchedule(
    response,
    workflowClient,
    sheetWorkflowsClient,
    capabilityStore,
    scheduleInput,
  ).pipe(Effect.provideService(Ix.Interaction, makeScheduleInteraction()));

describe("schedule command workflow enqueue", () => {
  layer(scheduleEnqueueLayer)("with command dependencies", (tests) => {
    it("binds the opaque Response Reference to the requested workspace", () => {
      expect(
        makeScheduleResponseReferenceInput({
          applicationId: "application-1",
          clientId: "client-1",
          interactionId: "123456789012345678",
          interactionToken: "provider-token",
          workspaceId: "workspace-1",
        }),
      ).toEqual({
        applicationId: "application-1",
        client: { platform: "discord", clientId: "client-1" },
        interactionToken: "provider-token",
        permittedOperations: ["respond"],
        expiresAt: 1449505662216,
        workspaceId: "workspace-1",
      });
    });

    tests.effect("sends only the declared schedule input through the replacement path", () =>
      Effect.gen(function* () {
        let legacyDispatches = 0;
        let responseReferences = 0;
        let evaluatedInput: unknown;
        let enqueuedInput: unknown;
        let enqueuedInvocationId: SchedulesDeliverUserScheduleReference["invocationId"] | undefined;
        const workflowClient = makeScheduleWorkflowClient(
          (input, options) => {
            enqueuedInput = input;
            enqueuedInvocationId = options?.invocationId;
            if (enqueuedInvocationId === undefined) return Effect.die("invocation ID is required");
            return Effect.succeed({
              invocationId: enqueuedInvocationId,
              contractIdentity: "schedules.deliverUserSchedule" as const,
              wireVersion: "1" as const,
            });
          },
          (input: unknown) => {
            evaluatedInput = input;
            return Effect.succeed(replacementScheduleRolloutGateDecision);
          },
        );
        const response = makeResponse([]);

        yield* runScheduleEnqueue(
          response,
          workflowClient,
          makeScheduleCapabilityStore(() => {
            responseReferences += 1;
          }),
          makeScheduleSheetWorkflowsClient(() => {
            legacyDispatches += 1;
          }),
        );

        expect(evaluatedInput).toMatchObject({
          contractIdentity: "schedules.deliverUserSchedule",
          contractWireVersion: "1",
          client: { platform: "discord", clientId: "discord-main" },
          workspaceId: "workspace-1",
        });
        expect(enqueuedInput).toEqual({
          ...scheduleInput,
          responseReference: "opaque-response-reference",
        });
        expect(enqueuedInvocationId).toBeDefined();
        expect(responseReferences).toBe(1);
        expect(legacyDispatches).toBe(0);
        expect(enqueuedInput).not.toHaveProperty("interactionToken");
        expect(enqueuedInput).not.toHaveProperty("targetUserPrincipal");
      }),
    );

    tests.effect("uses the legacy path when the Rollout Gate selects it", () =>
      Effect.gen(function* () {
        let legacyDispatches = 0;
        let replacementEnqueues = 0;
        let responseReferences = 0;
        const workflowClient = makeScheduleWorkflowClient(
          () => {
            replacementEnqueues += 1;
            return Effect.succeed({});
          },
          () =>
            Effect.succeed({
              ...replacementScheduleRolloutGateDecision,
              executionPath: "legacy" as const,
              reason: "legacy-enabled",
            }),
        );

        yield* runScheduleEnqueue(
          makeResponse([]),
          workflowClient,
          makeScheduleCapabilityStore(() => {
            responseReferences += 1;
          }),
          makeScheduleSheetWorkflowsClient(() => {
            legacyDispatches += 1;
          }),
        );

        expect(legacyDispatches).toBe(1);
        expect(replacementEnqueues).toBe(0);
        expect(responseReferences).toBe(0);
      }),
    );

    tests.effect("falls back to legacy when Rollout Gate evaluation fails", () =>
      Effect.gen(function* () {
        let legacyDispatches = 0;

        yield* runScheduleEnqueue(
          makeResponse([]),
          makeScheduleWorkflowClient(
            () => Effect.succeed({}),
            () => Effect.fail(new Error("Rollout Gate Control is unavailable")),
          ),
          makeScheduleCapabilityStore(),
          makeScheduleSheetWorkflowsClient(() => {
            legacyDispatches += 1;
          }),
        );

        expect(legacyDispatches).toBe(1);
      }),
    );

    tests.effect("reports definitive authorization rejection without using legacy", () =>
      Effect.gen(function* () {
        let legacyDispatches = 0;
        const messages: Array<string | undefined> = [];
        const exit = yield* Effect.exit(
          runScheduleEnqueue(
            makeResponse(messages),
            makeScheduleWorkflowClient(() =>
              Effect.fail({
                _tag: "WorkflowInvocationUnauthorized" as const,
                message: "schedule authorization denied",
              }),
            ),
            makeScheduleCapabilityStore(),
            makeScheduleSheetWorkflowsClient(() => {
              legacyDispatches += 1;
            }),
          ),
        );

        expect(Exit.isSuccess(exit)).toBe(true);
        expect(messages).toEqual(["You aren't allowed to view that user's schedule."]);
        expect(legacyDispatches).toBe(0);
      }),
    );

    tests.effect("reports definitive input rejection without retrying", () =>
      Effect.gen(function* () {
        let attempts = 0;
        let legacyDispatches = 0;
        const messages: Array<string | undefined> = [];
        const workflowClient = makeScheduleWorkflowClient(() => {
          attempts += 1;
          return Effect.fail(new WorkflowInputRejected({ message: "invalid schedule input" }));
        });

        yield* runScheduleEnqueue(
          makeResponse(messages),
          workflowClient,
          makeScheduleCapabilityStore(),
          makeScheduleSheetWorkflowsClient(() => {
            legacyDispatches += 1;
          }),
        );

        expect(attempts).toBe(1);
        expect(messages).toEqual(["I couldn't start the schedule lookup. Please try again."]);
        expect(legacyDispatches).toBe(0);
      }),
    );

    tests.effect("shows pending when enqueue outcome remains ambiguous", () =>
      Effect.gen(function* () {
        const calls: Array<SchedulesDeliverUserScheduleReference["invocationId"]> = [];
        const messages: Array<string | undefined> = [];
        let legacyDispatches = 0;
        const workflowClient = makeScheduleWorkflowClient((_, options) => {
          const invocationId = options?.invocationId;
          if (invocationId === undefined) return Effect.die("invocation ID is required");
          calls.push(invocationId);
          return Effect.fail(
            new WorkflowTransportUnavailable({
              operation: "Enqueue",
              retryable: false,
              message: "enqueue response was ambiguous",
            }),
          );
        });

        yield* runScheduleEnqueue(
          makeResponse(messages),
          workflowClient,
          makeScheduleCapabilityStore(),
          makeScheduleSheetWorkflowsClient(() => {
            legacyDispatches += 1;
          }),
        );

        expect(calls).toHaveLength(1);
        expect(calls[0]).toBeDefined();
        expect(messages).toEqual([
          "The schedule lookup is still processing. I'll update this message when it finishes.",
        ]);
        expect(legacyDispatches).toBe(0);
      }),
    );

    tests.effect("uses legacy when Rollout Gate evaluation times out", () =>
      Effect.gen(function* () {
        let legacyDispatches = 0;
        const fiber = yield* runScheduleEnqueue(
          makeResponse([]),
          makeScheduleWorkflowClient(
            () => Effect.succeed({}),
            () => Effect.never,
          ),
          makeScheduleCapabilityStore(),
          makeScheduleSheetWorkflowsClient(() => {
            legacyDispatches += 1;
          }),
        ).pipe(Effect.forkChild);

        yield* TestClock.adjust(Duration.seconds(5));
        yield* Fiber.join(fiber);

        expect(legacyDispatches).toBe(1);
      }),
    );
  });
});
