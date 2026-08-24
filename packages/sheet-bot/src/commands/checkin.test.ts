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
  type CheckinsOpenReference,
  type SheetWorkflowHttpClientShape,
  type SheetWorkflowsClientShape,
} from "../services";
import {
  enqueueCheckin,
  enqueueCheckinTestAuto,
  makeCheckinResponseReferenceInput,
} from "./checkin";

type CheckinTestWorkflowClient = Pick<
  SheetWorkflowHttpClientShape,
  | "enqueueCheckinsOpen"
  | "evaluateCheckinsOpenRolloutGate"
  | "enqueueCheckinsTestAuto"
  | "evaluateCheckinsTestAutoRolloutGate"
>;

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("workspace-1");

const replacementRolloutGateDecision = {
  gateKey: "gate-key",
  revision: 1,
  matched: true,
  executionPath: "replacement" as const,
  reason: "replacement-enabled",
};

const checkinInput = {
  workspaceId,
  conversationId: "channel-1",
  hour: 1,
  template: "Check in for hour {{hour}}",
} as const;

const testAutoInput = {
  workspaceId,
  anchorConversationId: "channel-1",
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
  enqueueCheckinsOpen,
  evaluateCheckinsOpenRolloutGate = () => Effect.succeed(replacementRolloutGateDecision),
  enqueueCheckinsTestAuto = () => Effect.succeed({}),
  evaluateCheckinsTestAutoRolloutGate = () => Effect.succeed(replacementRolloutGateDecision),
}: {
  readonly enqueueCheckinsOpen?: unknown;
  readonly evaluateCheckinsOpenRolloutGate?: unknown;
  readonly enqueueCheckinsTestAuto?: unknown;
  readonly evaluateCheckinsTestAutoRolloutGate?: unknown;
} = {}): CheckinTestWorkflowClient =>
  ({
    enqueueCheckinsOpen,
    evaluateCheckinsOpenRolloutGate,
    enqueueCheckinsTestAuto,
    evaluateCheckinsTestAutoRolloutGate,
  }) as unknown as CheckinTestWorkflowClient;

const makeSheetWorkflowsClient = ({
  onCheckin,
  onTestAuto,
  checkin = () => Effect.succeed({}),
  testAuto = () => Effect.succeed({}),
}: {
  readonly onCheckin?: () => void;
  readonly onTestAuto?: () => void;
  readonly checkin?: () => Effect.Effect<unknown, unknown, never>;
  readonly testAuto?: () => Effect.Effect<unknown, unknown, never>;
} = {}): SheetWorkflowsClientShape =>
  ({
    get: () => ({
      dispatch: {
        checkin: () => {
          onCheckin?.();
          return checkin();
        },
        autoCheckinTest: () => {
          onTestAuto?.();
          return testAuto();
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
    name: "checkin",
    type: ApplicationCommandType.ChatInput,
  },
  user: {
    id: "discord-user-1",
    username: "checkin-user",
    discriminator: "0001",
    global_name: "checkin-user",
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

const runCheckin = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: CheckinTestWorkflowClient,
  capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
) =>
  enqueueCheckin(
    response,
    workflowClient,
    sheetWorkflowsClient,
    capabilityStore,
    checkinInput,
  ).pipe(Effect.provideService(Ix.Interaction, makeInteraction()));

const runTestAuto = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: CheckinTestWorkflowClient,
  capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
) =>
  enqueueCheckinTestAuto(
    response,
    workflowClient,
    sheetWorkflowsClient,
    capabilityStore,
    testAutoInput,
  ).pipe(Effect.provideService(Ix.Interaction, makeInteraction()));

describe("check-in command workflow input", () => {
  it("keeps the provider token inside the opaque Response Reference", () => {
    expect(
      makeCheckinResponseReferenceInput({
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
  tests.effect("uses generated check-in input and reuses the invocation ID", () =>
    Effect.gen(function* () {
      let legacyDispatches = 0;
      let responseReferences = 0;
      let evaluatedInvocationId: string | undefined;
      let enqueuedInvocationId: CheckinsOpenReference["invocationId"] | undefined;
      let enqueuedInput: unknown;
      const workflowClient = makeWorkflowClient({
        evaluateCheckinsOpenRolloutGate: (input: { readonly invocationId: string }) => {
          evaluatedInvocationId = input.invocationId;
          return Effect.succeed(replacementRolloutGateDecision);
        },
        enqueueCheckinsOpen: (
          input: unknown,
          options?: { readonly invocationId?: CheckinsOpenReference["invocationId"] },
        ) => {
          enqueuedInput = input;
          enqueuedInvocationId = options?.invocationId;
          return Effect.succeed({});
        },
      });

      yield* runCheckin(
        makeResponse([]),
        workflowClient,
        makeCapabilityStore(() => {
          responseReferences += 1;
        }),
        makeSheetWorkflowsClient({ onCheckin: () => (legacyDispatches += 1) }),
      );

      expect(evaluatedInvocationId).toBeDefined();
      expect(enqueuedInvocationId).toBe(evaluatedInvocationId);
      expect(enqueuedInput).toEqual({
        ...checkinInput,
        responseReference: "opaque-response-reference",
      });
      expect(enqueuedInput).not.toHaveProperty("interactionToken");
      expect(responseReferences).toBe(1);
      expect(legacyDispatches).toBe(0);
    }),
  );

  tests.effect("uses legacy when the Rollout Gate does not select replacement", () =>
    Effect.gen(function* () {
      let legacyDispatches = 0;
      let replacementEnqueues = 0;
      let responseReferences = 0;

      yield* runCheckin(
        makeResponse([]),
        makeWorkflowClient({
          evaluateCheckinsOpenRolloutGate: () =>
            Effect.succeed({
              ...replacementRolloutGateDecision,
              executionPath: "legacy" as const,
              reason: "legacy-enabled",
            }),
          enqueueCheckinsOpen: () => {
            replacementEnqueues += 1;
            return Effect.succeed({});
          },
        }),
        makeCapabilityStore(() => {
          responseReferences += 1;
        }),
        makeSheetWorkflowsClient({ onCheckin: () => (legacyDispatches += 1) }),
      );

      expect(legacyDispatches).toBe(1);
      expect(replacementEnqueues).toBe(0);
      expect(responseReferences).toBe(0);
    }),
  );

  tests.effect("renders typed authorization rejection without legacy execution", () =>
    Effect.gen(function* () {
      let legacyDispatches = 0;
      const messages: Array<string | undefined> = [];

      yield* runCheckin(
        makeResponse(messages),
        makeWorkflowClient({
          enqueueCheckinsOpen: () =>
            Effect.fail({
              _tag: "WorkflowInvocationUnauthorized" as const,
              message: "check-in authorization denied",
            }),
        }),
        makeCapabilityStore(),
        makeSheetWorkflowsClient({ onCheckin: () => (legacyDispatches += 1) }),
      );

      expect(messages).toEqual(["You aren't allowed to start a check-in for that workspace."]);
      expect(legacyDispatches).toBe(0);
    }),
  );

  tests.effect("shows pending when the generated enqueue outcome is ambiguous", () =>
    Effect.gen(function* () {
      const messages: Array<string | undefined> = [];
      let legacyDispatches = 0;

      yield* runCheckin(
        makeResponse(messages),
        makeWorkflowClient({
          enqueueCheckinsOpen: () =>
            Effect.fail(
              new WorkflowTransportUnavailable({
                operation: "Enqueue",
                retryable: false,
                message: "enqueue response was ambiguous",
              }),
            ),
        }),
        makeCapabilityStore(),
        makeSheetWorkflowsClient({ onCheckin: () => (legacyDispatches += 1) }),
      );

      expect(messages).toEqual([
        "The check-in is still processing. I'll update this message when it finishes.",
      ]);
      expect(legacyDispatches).toBe(0);
    }),
  );

  tests.effect("routes the auto check-in test through its declared contract", () =>
    Effect.gen(function* () {
      let evaluatedContractIdentity: string | undefined;
      let enqueuedInput: unknown;
      let legacyDispatches = 0;

      yield* runTestAuto(
        makeResponse([]),
        makeWorkflowClient({
          evaluateCheckinsTestAutoRolloutGate: (input: { readonly contractIdentity: string }) => {
            evaluatedContractIdentity = input.contractIdentity;
            return Effect.succeed(replacementRolloutGateDecision);
          },
          enqueueCheckinsTestAuto: (input: unknown) => {
            enqueuedInput = input;
            return Effect.succeed({});
          },
        }),
        makeCapabilityStore(),
        makeSheetWorkflowsClient({ onTestAuto: () => (legacyDispatches += 1) }),
      );

      expect(evaluatedContractIdentity).toBe("checkins.testAuto");
      expect(enqueuedInput).toEqual({
        ...testAutoInput,
        responseReference: "opaque-response-reference",
      });
      expect(legacyDispatches).toBe(0);
    }),
  );

  tests.effect("renders input rejection for the auto check-in test", () =>
    Effect.gen(function* () {
      const messages: Array<string | undefined> = [];

      yield* runTestAuto(
        makeResponse(messages),
        makeWorkflowClient({
          enqueueCheckinsTestAuto: () =>
            Effect.fail(new WorkflowInputRejected({ message: "invalid test input" })),
        }),
        makeCapabilityStore(),
        makeSheetWorkflowsClient(),
      );

      expect(messages).toEqual(["I couldn't start the auto check-in test. Please try again."]);
    }),
  );
});
