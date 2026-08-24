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
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import type { CommandInteractionResponseContext } from "dfx-discord-utils/utils";
import { ResponseReference } from "sheet-bot-api/references";
import { WorkspaceId } from "sheet-workflow-contracts/values";
import { WorkflowInputRejected, WorkflowTransportUnavailable } from "sheet-workflow-http-client";
import {
  BotCapabilityStore,
  type SheetWorkflowHttpClientShape,
  type SheetWorkflowsClientShape,
  type SlotsDeliverListReference,
} from "../services";
import { enqueueSlotButton, enqueueSlotList, makeSlotResponseReferenceInput } from "./slot";

type SlotTestWorkflowClient = Pick<
  SheetWorkflowHttpClientShape,
  | "enqueueSlotsDeliverList"
  | "evaluateSlotsDeliverListRolloutGate"
  | "enqueueSlotsPublishButton"
  | "evaluateSlotsPublishButtonRolloutGate"
>;

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("workspace-1");

const replacementRolloutGateDecision = {
  gateKey: "gate-key",
  revision: 1,
  matched: true,
  executionPath: "replacement" as const,
  reason: "replacement-enabled",
};

const slotListInput = {
  workspaceId,
  day: 2,
  messageType: "ephemeral" as const,
} as const;

const slotButtonInput = {
  workspaceId,
  conversationId: "channel-1",
  day: 2,
} as const;

const makeCapabilityStore = (onIssueResponseReference: () => void = () => {}) => {
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

const makeWorkflowClient = ({
  enqueueSlotsDeliverList = () => Effect.succeed({}),
  evaluateSlotsDeliverListRolloutGate = () => Effect.succeed(replacementRolloutGateDecision),
  enqueueSlotsPublishButton = () => Effect.succeed({}),
  evaluateSlotsPublishButtonRolloutGate = () => Effect.succeed(replacementRolloutGateDecision),
}: {
  readonly enqueueSlotsDeliverList?: unknown;
  readonly evaluateSlotsDeliverListRolloutGate?: unknown;
  readonly enqueueSlotsPublishButton?: unknown;
  readonly evaluateSlotsPublishButtonRolloutGate?: unknown;
} = {}): SlotTestWorkflowClient =>
  ({
    enqueueSlotsDeliverList,
    evaluateSlotsDeliverListRolloutGate,
    enqueueSlotsPublishButton,
    evaluateSlotsPublishButtonRolloutGate,
  }) as unknown as SlotTestWorkflowClient;

const makeSheetWorkflowsClient = ({
  onSlotList,
  onSlotButton,
  slotList = () => Effect.succeed({}),
  slotButton = () => Effect.succeed({}),
}: {
  readonly onSlotList?: () => void;
  readonly onSlotButton?: () => void;
  readonly slotList?: () => Effect.Effect<unknown, unknown, never>;
  readonly slotButton?: () => Effect.Effect<unknown, unknown, never>;
} = {}): SheetWorkflowsClientShape =>
  ({
    get: () => ({
      dispatch: {
        slotList: () => {
          onSlotList?.();
          return slotList();
        },
        slotButton: () => {
          onSlotButton?.();
          return slotButton();
        },
      },
    }),
  }) as unknown as SheetWorkflowsClientShape;

const enqueueLayer = Layer.mergeAll(
  Layer.succeed(InteractionToken, {
    applicationId: "application-1",
    token: "provider-token",
  }),
  ConfigProvider.layer(ConfigProvider.fromUnknown({ SHEET_BOT_CLIENT_ID: "discord-main" })),
);

const makeInteraction = (): APIChatInputApplicationCommandInteraction => ({
  id: "123456789012345678",
  application_id: "application-1",
  type: InteractionType.ApplicationCommand,
  data: {
    id: "command-1",
    name: "slot",
    type: ApplicationCommandType.ChatInput,
  },
  user: {
    id: "discord-user-1",
    username: "slot-user",
    discriminator: "0001",
    global_name: "slot-user",
    avatar: null,
  },
  channel_id: "channel-1",
  channel: { id: "channel-1", type: ChannelType.GuildText },
  token: "provider-token",
  version: 1,
  app_permissions: "0",
  locale: Locale.EnglishUS,
  entitlements: [],
  authorizing_integration_owners: {},
  attachment_size_limit: 8_000_000,
  guild: { id: "workspace-1", features: [], locale: Locale.EnglishUS },
});

const makeResponse = (messages: Array<string | undefined>) =>
  ({
    editReply: ({ payload }: { readonly payload: { readonly content?: string } }) => {
      messages.push(payload.content);
      return Effect.void;
    },
  }) as Pick<CommandInteractionResponseContext, "editReply">;

const runSlotList = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: SlotTestWorkflowClient,
  capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
) =>
  enqueueSlotList(
    response,
    workflowClient,
    sheetWorkflowsClient,
    capabilityStore,
    slotListInput,
  ).pipe(Effect.provideService(Ix.Interaction, makeInteraction()));

const runSlotButton = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: SlotTestWorkflowClient,
  capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
) =>
  enqueueSlotButton(
    response,
    workflowClient,
    sheetWorkflowsClient,
    capabilityStore,
    slotButtonInput,
  ).pipe(Effect.provideService(Ix.Interaction, makeInteraction()));

describe("slot command workflow input", () => {
  it("binds a generated response reference to the workspace", () => {
    expect(
      makeSlotResponseReferenceInput({
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
});

layer(enqueueLayer)("with command dependencies", (tests) => {
  tests.effect("uses generated slot-list input and reuses the invocation ID", () =>
    Effect.gen(function* () {
      let evaluatedInvocationId: string | undefined;
      let enqueuedInvocationId: SlotsDeliverListReference["invocationId"] | undefined;
      let enqueuedInput: unknown;
      let legacyDispatches = 0;
      let responseReferences = 0;
      const workflowClient = makeWorkflowClient({
        evaluateSlotsDeliverListRolloutGate: (input: { readonly invocationId: string }) => {
          evaluatedInvocationId = input.invocationId;
          return Effect.succeed(replacementRolloutGateDecision);
        },
        enqueueSlotsDeliverList: (
          input: unknown,
          options?: { readonly invocationId?: SlotsDeliverListReference["invocationId"] },
        ) => {
          enqueuedInput = input;
          enqueuedInvocationId = options?.invocationId;
          return Effect.succeed({});
        },
      });

      yield* runSlotList(
        makeResponse([]),
        workflowClient,
        makeCapabilityStore(() => {
          responseReferences += 1;
        }),
        makeSheetWorkflowsClient({ onSlotList: () => (legacyDispatches += 1) }),
      );

      expect(evaluatedInvocationId).toBeDefined();
      expect(enqueuedInvocationId).toBe(evaluatedInvocationId);
      expect(enqueuedInput).toEqual({
        ...slotListInput,
        responseReference: "opaque-response-reference",
      });
      expect(enqueuedInput).not.toHaveProperty("interactionToken");
      expect(responseReferences).toBe(1);
      expect(legacyDispatches).toBe(0);
    }),
  );

  tests.effect("uses legacy for slot-button delivery when the gate selects it", () =>
    Effect.gen(function* () {
      let legacyDispatches = 0;
      let replacementEnqueues = 0;
      let responseReferences = 0;

      yield* runSlotButton(
        makeResponse([]),
        makeWorkflowClient({
          evaluateSlotsPublishButtonRolloutGate: () =>
            Effect.succeed({
              ...replacementRolloutGateDecision,
              executionPath: "legacy" as const,
              reason: "legacy-enabled",
            }),
          enqueueSlotsPublishButton: () => {
            replacementEnqueues += 1;
            return Effect.succeed({});
          },
        }),
        makeCapabilityStore(() => {
          responseReferences += 1;
        }),
        makeSheetWorkflowsClient({ onSlotButton: () => (legacyDispatches += 1) }),
      );

      expect(legacyDispatches).toBe(1);
      expect(replacementEnqueues).toBe(0);
      expect(responseReferences).toBe(0);
    }),
  );

  tests.effect("renders slot-button authorization rejection without legacy execution", () =>
    Effect.gen(function* () {
      let legacyDispatches = 0;
      const messages: Array<string | undefined> = [];

      yield* runSlotButton(
        makeResponse(messages),
        makeWorkflowClient({
          enqueueSlotsPublishButton: () =>
            Effect.fail({
              _tag: "WorkflowInvocationUnauthorized" as const,
              message: "slot-button authorization denied",
            }),
        }),
        makeCapabilityStore(),
        makeSheetWorkflowsClient({ onSlotButton: () => (legacyDispatches += 1) }),
      );

      expect(messages).toEqual(["You aren't allowed to publish a slot button in that workspace."]);
      expect(legacyDispatches).toBe(0);
    }),
  );

  tests.effect("renders input rejection for the slot list", () =>
    Effect.gen(function* () {
      const messages: Array<string | undefined> = [];

      yield* runSlotList(
        makeResponse(messages),
        makeWorkflowClient({
          enqueueSlotsDeliverList: () =>
            Effect.fail(new WorkflowInputRejected({ message: "invalid slot input" })),
        }),
        makeCapabilityStore(),
        makeSheetWorkflowsClient(),
      );

      expect(messages).toEqual(["I couldn't start the slot list. Please try again."]);
    }),
  );

  tests.effect("shows pending when the slot-list enqueue outcome is ambiguous", () =>
    Effect.gen(function* () {
      const messages: Array<string | undefined> = [];
      let legacyDispatches = 0;

      yield* runSlotList(
        makeResponse(messages),
        makeWorkflowClient({
          enqueueSlotsDeliverList: () =>
            Effect.fail(
              new WorkflowTransportUnavailable({
                operation: "Enqueue",
                retryable: false,
                message: "enqueue response was ambiguous",
              }),
            ),
        }),
        makeCapabilityStore(),
        makeSheetWorkflowsClient({ onSlotList: () => (legacyDispatches += 1) }),
      );

      expect(messages).toEqual([
        "The slot request is still processing. I'll update this message when it finishes.",
      ]);
      expect(legacyDispatches).toBe(0);
    }),
  );

  tests.effect("routes slot-button input through its declared contract", () =>
    Effect.gen(function* () {
      let evaluatedContractIdentity: string | undefined;
      let enqueuedInput: unknown;
      let legacyDispatches = 0;

      yield* runSlotButton(
        makeResponse([]),
        makeWorkflowClient({
          evaluateSlotsPublishButtonRolloutGate: (input: { readonly contractIdentity: string }) => {
            evaluatedContractIdentity = input.contractIdentity;
            return Effect.succeed(replacementRolloutGateDecision);
          },
          enqueueSlotsPublishButton: (input: unknown) => {
            enqueuedInput = input;
            return Effect.succeed({});
          },
        }),
        makeCapabilityStore(),
        makeSheetWorkflowsClient({ onSlotButton: () => (legacyDispatches += 1) }),
      );

      expect(evaluatedContractIdentity).toBe("slots.publishButton");
      expect(enqueuedInput).toEqual({
        ...slotButtonInput,
        responseReference: "opaque-response-reference",
      });
      expect(legacyDispatches).toBe(0);
    }),
  );
});
