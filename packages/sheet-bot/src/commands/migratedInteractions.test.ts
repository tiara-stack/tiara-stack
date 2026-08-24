import { expect, layer } from "@effect/vitest";
import { Ix } from "dfx";
import type { APIChatInputApplicationCommandInteraction } from "dfx/types";
import {
  ApplicationCommandType,
  ChannelType,
  InteractionType,
  Locale,
} from "discord-api-types/v10";
import { InteractionToken } from "dfx-discord-utils/utils";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import type { CommandInteractionResponseContext } from "dfx-discord-utils/utils";
import { ResponseReference } from "sheet-bot-api/references";
import { WorkflowInputRejected } from "sheet-workflow-http-client";
import { enqueueKick } from "./kick";
import { enqueueRoomOrder } from "./roomOrder";
import { enqueueScreenshot } from "./screenshot";
import {
  BotCapabilityStore,
  type MembersKickInput,
  type RoomOrdersCreateInput,
  type ScreenshotsCaptureAndDeliverInput,
  type SheetWorkflowHttpClientShape,
  type SheetWorkflowsClientShape,
} from "../services";

type WorkflowEnqueueOptions = { readonly invocationId?: string };

const workflowWorkspaceId = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(
  Schema.brand("sheet-workflow-contracts/WorkspaceId"),
);
const workspaceId = Schema.decodeUnknownSync(workflowWorkspaceId)("workspace-1");
const responseReference = Schema.decodeUnknownSync(ResponseReference)("opaque-response-reference");

const replacementRolloutGateDecision = {
  gateKey: "gate-key",
  revision: 1,
  matched: true,
  executionPath: "replacement" as const,
  reason: "replacement-enabled",
};

const makeInteraction = (): APIChatInputApplicationCommandInteraction => ({
  id: "123456789012345678",
  application_id: "application-1",
  type: InteractionType.ApplicationCommand,
  data: {
    id: "command-1",
    name: "migrated-interaction",
    type: ApplicationCommandType.ChatInput,
  },
  user: {
    id: "discord-user-1",
    username: "migrated-user",
    discriminator: "0001",
    global_name: "migrated-user",
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
  guild: { id: "workspace-1", features: [], locale: Locale.EnglishUS },
});

const commandDependencyLayer = Layer.mergeAll(
  Layer.succeed(InteractionToken, {
    applicationId: "application-1",
    token: "interaction-token",
  }),
  ConfigProvider.layer(ConfigProvider.fromUnknown({ SHEET_BOT_CLIENT_ID: "discord-main" })),
);

const makeResponse = (messages: Array<string | undefined>) =>
  ({
    editReply: ({ payload }: { readonly payload: { readonly content?: string } }) => {
      messages.push(payload.content);
      return Effect.void;
    },
  }) as Pick<CommandInteractionResponseContext, "editReply">;

const makeCapabilityStore = (onIssueResponseReference: (input: unknown) => void = () => {}) =>
  ({
    issueResponseReference: (input: unknown) => {
      onIssueResponseReference(input);
      return Effect.succeed(responseReference);
    },
  }) as Pick<typeof BotCapabilityStore.Service, "issueResponseReference">;

const makeLegacyClient = (onDispatch: (operation: string) => void): SheetWorkflowsClientShape =>
  ({
    get: () => ({
      dispatch: {
        roomOrder: ({ payload }: { readonly payload: unknown }) => {
          void payload;
          onDispatch("roomOrder");
          return Effect.succeed({});
        },
        kick: ({ payload }: { readonly payload: unknown }) => {
          void payload;
          onDispatch("kick");
          return Effect.succeed({});
        },
        screenshot: ({ payload }: { readonly payload: unknown }) => {
          void payload;
          onDispatch("screenshot");
          return Effect.succeed({});
        },
      },
    }),
  }) as unknown as SheetWorkflowsClientShape;

const makeAcceptedEnqueue =
  (operation: string, onEnqueue: (input: unknown) => void) =>
  (input: unknown, options?: WorkflowEnqueueOptions) => {
    onEnqueue({ operation, input, invocationId: options?.invocationId });
    return options?.invocationId === undefined
      ? Effect.die("invocation ID is required")
      : Effect.succeed({
          invocationId: options.invocationId,
          contractIdentity: operation,
          wireVersion: "1",
        });
  };

const makeReplacementRoomOrderClient = (
  onEnqueue: (input: unknown) => void,
): Pick<
  SheetWorkflowHttpClientShape,
  "enqueueRoomOrdersCreate" | "evaluateRoomOrdersCreateRolloutGate"
> =>
  ({
    evaluateRoomOrdersCreateRolloutGate: () => Effect.succeed(replacementRolloutGateDecision),
    enqueueRoomOrdersCreate: makeAcceptedEnqueue("roomOrders.create", onEnqueue),
  }) as unknown as Pick<
    SheetWorkflowHttpClientShape,
    "enqueueRoomOrdersCreate" | "evaluateRoomOrdersCreateRolloutGate"
  >;

const makeReplacementKickClient = (
  onEnqueue: (input: unknown) => void,
): Pick<SheetWorkflowHttpClientShape, "enqueueMembersKick" | "evaluateMembersKickRolloutGate"> =>
  ({
    evaluateMembersKickRolloutGate: () => Effect.succeed(replacementRolloutGateDecision),
    enqueueMembersKick: makeAcceptedEnqueue("members.kick", onEnqueue),
  }) as unknown as Pick<
    SheetWorkflowHttpClientShape,
    "enqueueMembersKick" | "evaluateMembersKickRolloutGate"
  >;

const makeReplacementScreenshotClient = (
  onEnqueue: (input: unknown) => void,
): Pick<
  SheetWorkflowHttpClientShape,
  "enqueueScreenshotsCaptureAndDeliver" | "evaluateScreenshotsCaptureAndDeliverRolloutGate"
> =>
  ({
    evaluateScreenshotsCaptureAndDeliverRolloutGate: () =>
      Effect.succeed(replacementRolloutGateDecision),
    enqueueScreenshotsCaptureAndDeliver: makeAcceptedEnqueue(
      "screenshots.captureAndDeliver",
      onEnqueue,
    ),
  }) as unknown as Pick<
    SheetWorkflowHttpClientShape,
    "enqueueScreenshotsCaptureAndDeliver" | "evaluateScreenshotsCaptureAndDeliverRolloutGate"
  >;

const roomOrderInput = {
  workspaceId,
  conversationName: "running",
  hour: 12,
  healNeeded: 1,
} satisfies Omit<RoomOrdersCreateInput, "responseReference">;
const roomOrderLegacyInput = {
  workspaceId: "workspace-1",
  conversationName: "running",
  hour: 12,
  healNeeded: 1,
};

const membersKickInput = {
  workspaceId,
  conversationName: "running",
  hour: 12,
} satisfies Omit<MembersKickInput, "responseReference">;
const membersKickLegacyInput = {
  workspaceId: "workspace-1",
  conversationName: "running",
  hour: 12,
};

const screenshotInput = {
  workspaceId,
  conversationName: "running",
  day: 2,
} satisfies Omit<ScreenshotsCaptureAndDeliverInput, "responseReference">;
const screenshotLegacyInput = {
  workspaceId: "workspace-1",
  conversationName: "running",
  day: 2,
};

const withInteraction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Ix.Interaction, makeInteraction()));

layer(commandDependencyLayer)("migrated sheet-bot interactions", (tests) => {
  tests.effect("uses replacement workflows without a second legacy effect", () =>
    Effect.gen(function* () {
      const legacyDispatches: string[] = [];
      const enqueues: Array<{ readonly operation: string; readonly input: unknown }> = [];
      const responseReferences: unknown[] = [];
      const sheetWorkflowsClient = makeLegacyClient((operation) => {
        legacyDispatches.push(operation);
      });
      const capabilityStore = makeCapabilityStore((input) => {
        responseReferences.push(input);
      });
      const response = makeResponse([]);

      yield* withInteraction(
        enqueueRoomOrder(
          response,
          makeReplacementRoomOrderClient((entry) => {
            enqueues.push(entry as { readonly operation: string; readonly input: unknown });
          }),
          sheetWorkflowsClient,
          capabilityStore,
          roomOrderInput,
          roomOrderLegacyInput,
        ),
      );
      yield* withInteraction(
        enqueueKick(
          response,
          makeReplacementKickClient((entry) => {
            enqueues.push(entry as { readonly operation: string; readonly input: unknown });
          }),
          sheetWorkflowsClient,
          capabilityStore,
          membersKickInput,
          membersKickLegacyInput,
        ),
      );
      yield* withInteraction(
        enqueueScreenshot(
          response,
          makeReplacementScreenshotClient((entry) => {
            enqueues.push(entry as { readonly operation: string; readonly input: unknown });
          }),
          sheetWorkflowsClient,
          capabilityStore,
          screenshotInput,
          screenshotLegacyInput,
        ),
      );

      expect(legacyDispatches).toEqual([]);
      expect(responseReferences).toHaveLength(3);
      expect(enqueues).toHaveLength(3);
      for (const reference of responseReferences) {
        expect(reference).toMatchObject({
          permittedOperations: ["respond"],
          workspaceId: "workspace-1",
        });
      }
      expect(enqueues.map(({ operation }) => operation)).toEqual([
        "roomOrders.create",
        "members.kick",
        "screenshots.captureAndDeliver",
      ]);
      expect(enqueues[0]?.input).toEqual({
        ...roomOrderInput,
        responseReference,
      });
      expect(enqueues[1]?.input).toEqual({
        ...membersKickInput,
        responseReference,
      });
      expect(enqueues[2]?.input).toEqual({
        ...screenshotInput,
        responseReference,
      });
      for (const { input } of enqueues) {
        expect(input).not.toHaveProperty("interactionToken");
        expect(input).not.toHaveProperty("interactionResponseToken");
      }
    }),
  );

  tests.effect("falls back once per caller when Rollout Gate control is unavailable", () =>
    Effect.gen(function* () {
      const legacyDispatches: string[] = [];
      const sheetWorkflowsClient = makeLegacyClient((operation) => {
        legacyDispatches.push(operation);
      });
      const capabilityStore = makeCapabilityStore();
      const response = makeResponse([]);
      const gateUnavailable = () => Effect.fail(new Error("Rollout Gate Control unavailable"));
      const workflowClient = {
        evaluateRoomOrdersCreateRolloutGate: gateUnavailable,
        enqueueRoomOrdersCreate: () => Effect.die("replacement must not run"),
        evaluateMembersKickRolloutGate: gateUnavailable,
        enqueueMembersKick: () => Effect.die("replacement must not run"),
        evaluateScreenshotsCaptureAndDeliverRolloutGate: gateUnavailable,
        enqueueScreenshotsCaptureAndDeliver: () => Effect.die("replacement must not run"),
      } as unknown as SheetWorkflowHttpClientShape;

      yield* withInteraction(
        enqueueRoomOrder(
          response,
          workflowClient,
          sheetWorkflowsClient,
          capabilityStore,
          roomOrderInput,
          roomOrderLegacyInput,
        ),
      );
      yield* withInteraction(
        enqueueKick(
          response,
          workflowClient,
          sheetWorkflowsClient,
          capabilityStore,
          membersKickInput,
          membersKickLegacyInput,
        ),
      );
      yield* withInteraction(
        enqueueScreenshot(
          response,
          workflowClient,
          sheetWorkflowsClient,
          capabilityStore,
          screenshotInput,
          screenshotLegacyInput,
        ),
      );

      expect(legacyDispatches).toEqual(["roomOrder", "kick", "screenshot"]);
    }),
  );

  tests.effect(
    "renders typed authorization and declared input failures without legacy dispatch",
    () =>
      Effect.gen(function* () {
        const legacyDispatches: string[] = [];
        const messages: Array<string | undefined> = [];
        const sheetWorkflowsClient = makeLegacyClient((operation) => {
          legacyDispatches.push(operation);
        });
        const capabilityStore = makeCapabilityStore();
        const roomWorkflowClient = {
          evaluateRoomOrdersCreateRolloutGate: () => Effect.succeed(replacementRolloutGateDecision),
          enqueueRoomOrdersCreate: () =>
            Effect.fail({
              _tag: "WorkflowInvocationUnauthorized" as const,
              message: "room order denied",
            }),
        } as unknown as Pick<
          SheetWorkflowHttpClientShape,
          "enqueueRoomOrdersCreate" | "evaluateRoomOrdersCreateRolloutGate"
        >;
        const screenshotWorkflowClient = {
          evaluateScreenshotsCaptureAndDeliverRolloutGate: () =>
            Effect.succeed(replacementRolloutGateDecision),
          enqueueScreenshotsCaptureAndDeliver: () =>
            Effect.fail(new WorkflowInputRejected({ message: "screenshot input rejected" })),
        } as unknown as Pick<
          SheetWorkflowHttpClientShape,
          "enqueueScreenshotsCaptureAndDeliver" | "evaluateScreenshotsCaptureAndDeliverRolloutGate"
        >;

        yield* withInteraction(
          enqueueRoomOrder(
            makeResponse(messages),
            roomWorkflowClient,
            sheetWorkflowsClient,
            capabilityStore,
            roomOrderInput,
            roomOrderLegacyInput,
          ),
        );
        yield* withInteraction(
          enqueueScreenshot(
            makeResponse(messages),
            screenshotWorkflowClient,
            sheetWorkflowsClient,
            capabilityStore,
            screenshotInput,
            screenshotLegacyInput,
          ),
        );

        expect(messages).toEqual([
          "You aren't allowed to create a room order.",
          "I couldn't start the screenshot. Please try again.",
        ]);
        expect(legacyDispatches).toEqual([]);
      }),
  );
});
