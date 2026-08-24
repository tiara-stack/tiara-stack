import { expect, layer } from "@effect/vitest";
import { Ix } from "dfx";
import type { APIMessageComponentButtonInteraction } from "discord-api-types/v10";
import { InteractionToken } from "dfx-discord-utils/utils";
import { ComponentType, InteractionType } from "discord-api-types/v10";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import type { CommandInteractionResponseContext } from "dfx-discord-utils/utils";
import { ResponseReference } from "sheet-bot-api/references";
import { WorkflowTransportUnavailable } from "sheet-workflow-http-client";
import {
  BotCapabilityStore,
  type CheckinsRespondReference,
  type SheetWorkflowHttpClientShape,
  type SheetWorkflowsClientShape,
} from "../../services";
import { enqueueCheckinButton } from "./checkin";
import { enqueueSlotOpenButton } from "./slot";

type ButtonTestWorkflowClient = Pick<
  SheetWorkflowHttpClientShape,
  | "enqueueCheckinsRespond"
  | "evaluateCheckinsRespondRolloutGate"
  | "enqueueSlotsOpen"
  | "evaluateSlotsOpenRolloutGate"
>;

const replacementRolloutGateDecision = {
  gateKey: "gate-key",
  revision: 1,
  matched: true,
  executionPath: "replacement" as const,
  reason: "replacement-enabled",
};

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
  enqueueCheckinsRespond = () => Effect.succeed({}),
  evaluateCheckinsRespondRolloutGate = () => Effect.succeed(replacementRolloutGateDecision),
  enqueueSlotsOpen = () => Effect.succeed({}),
  evaluateSlotsOpenRolloutGate = () => Effect.succeed(replacementRolloutGateDecision),
}: {
  readonly enqueueCheckinsRespond?: unknown;
  readonly evaluateCheckinsRespondRolloutGate?: unknown;
  readonly enqueueSlotsOpen?: unknown;
  readonly evaluateSlotsOpenRolloutGate?: unknown;
} = {}): ButtonTestWorkflowClient =>
  ({
    enqueueCheckinsRespond,
    evaluateCheckinsRespondRolloutGate,
    enqueueSlotsOpen,
    evaluateSlotsOpenRolloutGate,
  }) as unknown as ButtonTestWorkflowClient;

const makeSheetWorkflowsClient = ({
  onCheckinButton,
  onSlotOpenButton,
}: {
  readonly onCheckinButton?: () => void;
  readonly onSlotOpenButton?: () => void;
} = {}): SheetWorkflowsClientShape =>
  ({
    get: () => ({
      dispatch: {
        checkinButton: () => {
          onCheckinButton?.();
          return Effect.succeed({});
        },
        slotOpenButton: () => {
          onSlotOpenButton?.();
          return Effect.succeed({});
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

const makeInteraction = (): APIMessageComponentButtonInteraction =>
  ({
    id: "123456789012345678",
    application_id: "application-1",
    type: InteractionType.MessageComponent,
    data: {
      custom_id: "button",
      component_type: ComponentType.Button,
    },
    user: {
      id: "discord-user-1",
      username: "button-user",
      discriminator: "0001",
      global_name: "button-user",
      avatar: null,
    },
    guild: { id: "123456789012345678" },
    token: "provider-token",
  }) as APIMessageComponentButtonInteraction;

const makeResponse = (messages: Array<string | undefined>) =>
  ({
    editReply: ({ payload }: { readonly payload: { readonly content?: string } }) => {
      messages.push(payload.content);
      return Effect.void;
    },
  }) as Pick<CommandInteractionResponseContext, "editReply">;

const runCheckinButton = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: ButtonTestWorkflowClient,
  capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
) =>
  enqueueCheckinButton(
    response,
    workflowClient,
    sheetWorkflowsClient,
    capabilityStore,
    "message-1",
  ).pipe(Effect.provideService(Ix.Interaction, makeInteraction()));

const runSlotOpenButton = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: ButtonTestWorkflowClient,
  capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
) =>
  enqueueSlotOpenButton(
    response,
    workflowClient,
    sheetWorkflowsClient,
    capabilityStore,
    "message-1",
  ).pipe(Effect.provideService(Ix.Interaction, makeInteraction()));

layer(enqueueLayer)("button workflow enqueue", (tests) => {
  tests.effect("sends only the generated check-in response input", () =>
    Effect.gen(function* () {
      let evaluatedInvocationId: string | undefined;
      let evaluatedWorkspaceId: string | undefined;
      let enqueuedInvocationId: CheckinsRespondReference["invocationId"] | undefined;
      let enqueuedInput: unknown;
      let legacyDispatches = 0;
      let responseReferences = 0;

      yield* runCheckinButton(
        makeResponse([]),
        makeWorkflowClient({
          evaluateCheckinsRespondRolloutGate: (input: {
            readonly invocationId: string;
            readonly workspaceId?: string;
          }) => {
            evaluatedInvocationId = input.invocationId;
            evaluatedWorkspaceId = input.workspaceId;
            return Effect.succeed(replacementRolloutGateDecision);
          },
          enqueueCheckinsRespond: (
            input: unknown,
            options?: { readonly invocationId?: CheckinsRespondReference["invocationId"] },
          ) => {
            enqueuedInput = input;
            enqueuedInvocationId = options?.invocationId;
            return Effect.succeed({});
          },
        }),
        makeCapabilityStore(() => {
          responseReferences += 1;
        }),
        makeSheetWorkflowsClient({ onCheckinButton: () => (legacyDispatches += 1) }),
      );

      expect(evaluatedInvocationId).toBeDefined();
      expect(enqueuedInvocationId).toBe(evaluatedInvocationId);
      expect(evaluatedWorkspaceId).toBe("123456789012345678");
      expect(enqueuedInput).toEqual({
        messageId: "message-1",
        responseReference: "opaque-response-reference",
      });
      expect(enqueuedInput).not.toHaveProperty("interactionToken");
      expect(responseReferences).toBe(1);
      expect(legacyDispatches).toBe(0);
    }),
  );

  tests.effect("renders check-in button authorization rejection without legacy execution", () =>
    Effect.gen(function* () {
      const messages: Array<string | undefined> = [];
      let legacyDispatches = 0;

      yield* runCheckinButton(
        makeResponse(messages),
        makeWorkflowClient({
          enqueueCheckinsRespond: () =>
            Effect.fail({
              _tag: "WorkflowInvocationUnauthorized" as const,
              message: "button authorization denied",
            }),
        }),
        makeCapabilityStore(),
        makeSheetWorkflowsClient({ onCheckinButton: () => (legacyDispatches += 1) }),
      );

      expect(messages).toEqual(["You aren't allowed to check in from this message."]);
      expect(legacyDispatches).toBe(0);
    }),
  );

  tests.effect("shows pending when the check-in button enqueue outcome is ambiguous", () =>
    Effect.gen(function* () {
      const messages: Array<string | undefined> = [];
      let legacyDispatches = 0;

      yield* runCheckinButton(
        makeResponse(messages),
        makeWorkflowClient({
          enqueueCheckinsRespond: () =>
            Effect.fail(
              new WorkflowTransportUnavailable({
                operation: "Enqueue",
                retryable: false,
                message: "enqueue response was ambiguous",
              }),
            ),
        }),
        makeCapabilityStore(),
        makeSheetWorkflowsClient({ onCheckinButton: () => (legacyDispatches += 1) }),
      );

      expect(messages).toEqual([
        "Your check-in is still processing. I'll update this message when it finishes.",
      ]);
      expect(legacyDispatches).toBe(0);
    }),
  );

  tests.effect("uses legacy for slot-open buttons when the gate selects it", () =>
    Effect.gen(function* () {
      let legacyDispatches = 0;
      let replacementEnqueues = 0;
      let responseReferences = 0;
      let evaluatedWorkspaceId: string | undefined;

      yield* runSlotOpenButton(
        makeResponse([]),
        makeWorkflowClient({
          evaluateSlotsOpenRolloutGate: (input: { readonly workspaceId?: string }) => {
            evaluatedWorkspaceId = input.workspaceId;
            return Effect.succeed({
              ...replacementRolloutGateDecision,
              executionPath: "legacy" as const,
              reason: "legacy-enabled",
            });
          },
          enqueueSlotsOpen: () => {
            replacementEnqueues += 1;
            return Effect.succeed({});
          },
        }),
        makeCapabilityStore(() => {
          responseReferences += 1;
        }),
        makeSheetWorkflowsClient({ onSlotOpenButton: () => (legacyDispatches += 1) }),
      );

      expect(legacyDispatches).toBe(1);
      expect(replacementEnqueues).toBe(0);
      expect(responseReferences).toBe(0);
      expect(evaluatedWorkspaceId).toBe("123456789012345678");
    }),
  );

  tests.effect("sends only the generated slot-open response input", () =>
    Effect.gen(function* () {
      let enqueuedInput: unknown;
      let legacyDispatches = 0;
      let responseReferences = 0;

      yield* runSlotOpenButton(
        makeResponse([]),
        makeWorkflowClient({
          enqueueSlotsOpen: (input: unknown) => {
            enqueuedInput = input;
            return Effect.succeed({});
          },
        }),
        makeCapabilityStore(() => {
          responseReferences += 1;
        }),
        makeSheetWorkflowsClient({ onSlotOpenButton: () => (legacyDispatches += 1) }),
      );

      expect(enqueuedInput).toEqual({
        messageId: "message-1",
        responseReference: "opaque-response-reference",
      });
      expect(enqueuedInput).not.toHaveProperty("interactionToken");
      expect(responseReferences).toBe(1);
      expect(legacyDispatches).toBe(0);
    }),
  );

  tests.effect("shows pending when the slot-open button enqueue outcome is ambiguous", () =>
    Effect.gen(function* () {
      const messages: Array<string | undefined> = [];
      let legacyDispatches = 0;

      yield* runSlotOpenButton(
        makeResponse(messages),
        makeWorkflowClient({
          enqueueSlotsOpen: () =>
            Effect.fail(
              new WorkflowTransportUnavailable({
                operation: "Enqueue",
                retryable: false,
                message: "enqueue response was ambiguous",
              }),
            ),
        }),
        makeCapabilityStore(),
        makeSheetWorkflowsClient({ onSlotOpenButton: () => (legacyDispatches += 1) }),
      );

      expect(messages).toEqual([
        "The slot list is still processing. I'll update this message when it finishes.",
      ]);
      expect(legacyDispatches).toBe(0);
    }),
  );

  tests.effect("renders slot-open button authorization rejection", () =>
    Effect.gen(function* () {
      const messages: Array<string | undefined> = [];

      yield* runSlotOpenButton(
        makeResponse(messages),
        makeWorkflowClient({
          enqueueSlotsOpen: () =>
            Effect.fail({
              _tag: "WorkflowInvocationUnauthorized" as const,
              message: "slot button authorization denied",
            }),
        }),
        makeCapabilityStore(),
        makeSheetWorkflowsClient(),
      );

      expect(messages).toEqual(["You aren't allowed to open slots from this message."]);
    }),
  );
});
