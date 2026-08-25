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
import { Cause, ConfigProvider, Duration, Effect, Fiber, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import type { CommandInteractionResponseContext } from "dfx-discord-utils/utils";
import { ResponseReference } from "sheet-bot-api/references";
import {
  BotCapabilityStore,
  SheetWorkflowHttpClient,
  type ServicesDeliverStatusEnqueue,
  type SheetWorkflowsClientShape,
} from "../services";
import { enqueueStatus, makeStatusResponseReferenceInput } from "./status";

type StatusTestWorkflowClient = Pick<
  typeof SheetWorkflowHttpClient.Service,
  "enqueueServicesDeliverStatus" | "evaluateStatusRolloutGate"
>;

const replacementStatusRolloutGateDecision = {
  gateKey: "gate-key",
  revision: 1,
  matched: true,
  executionPath: "replacement" as const,
  reason: "replacement-enabled",
};

const makeStatusCapabilityStore = (
  onIssueResponseReference: (input: { readonly workspaceId?: string }) => void = () => {},
) => {
  const responseReference = Schema.decodeUnknownSync(ResponseReference)(
    "opaque-response-reference",
  );
  return {
    issueResponseReference: (input: { readonly workspaceId?: string }) => {
      onIssueResponseReference(input);
      return Effect.succeed(responseReference);
    },
  } as Pick<typeof BotCapabilityStore.Service, "issueResponseReference">;
};

const makeStatusWorkflowClient = (
  enqueueServicesDeliverStatus: unknown,
  evaluateStatusRolloutGate: unknown = () => Effect.succeed(replacementStatusRolloutGateDecision),
) =>
  ({
    evaluateStatusRolloutGate,
    enqueueServicesDeliverStatus,
  }) as unknown as StatusTestWorkflowClient;

const makeStatusSheetWorkflowsClient = (
  onLegacyDispatch: () => void,
  serviceStatus: () => Effect.Effect<unknown, unknown, never> = () => Effect.succeed({}),
): SheetWorkflowsClientShape =>
  ({
    get: () => ({
      dispatch: {
        serviceStatus: () => {
          onLegacyDispatch();
          return serviceStatus();
        },
      },
    }),
  }) as unknown as SheetWorkflowsClientShape;

const statusTestSheetWorkflowsClient = makeStatusSheetWorkflowsClient(() => {});

const statusEnqueueLayer = Layer.mergeAll(
  Layer.succeed(InteractionToken, {
    applicationId: "application-1",
    token: "interaction-token",
  }),
  ConfigProvider.layer(ConfigProvider.fromUnknown({ SHEET_BOT_CLIENT_ID: "discord-main" })),
);

const makeStatusInteraction = (guildId?: string): APIChatInputApplicationCommandInteraction => ({
  id: "123456789012345678",
  application_id: "application-1",
  type: InteractionType.ApplicationCommand,
  data: {
    id: "command-1",
    name: "status",
    type: ApplicationCommandType.ChatInput,
  },
  user: {
    id: "discord-user-1",
    username: "status-user",
    discriminator: "0001",
    global_name: "status-user",
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
  ...(guildId === undefined
    ? {}
    : { guild: { id: guildId, features: [], locale: Locale.EnglishUS } }),
});

const runStatusEnqueue = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: StatusTestWorkflowClient,
  capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">,
  sheetWorkflowsClient: SheetWorkflowsClientShape = statusTestSheetWorkflowsClient,
  guildId?: string,
) =>
  enqueueStatus(response, workflowClient, sheetWorkflowsClient, capabilityStore).pipe(
    Effect.provideService(Ix.Interaction, makeStatusInteraction(guildId)),
  );

const assertLegacyStatusFallback = (evaluateStatusRolloutGate: unknown) =>
  Effect.gen(function* () {
    let legacyDispatches = 0;
    let replacementEnqueues = 0;
    let responseReferences = 0;
    const capabilityStore = makeStatusCapabilityStore(() => {
      responseReferences += 1;
    });
    const workflowClient = makeStatusWorkflowClient(() => {
      replacementEnqueues += 1;
      return Effect.succeed({});
    }, evaluateStatusRolloutGate);
    const response = {
      editReply: () => Effect.void,
    } as Pick<CommandInteractionResponseContext, "editReply">;

    yield* runStatusEnqueue(
      response,
      workflowClient,
      capabilityStore,
      makeStatusSheetWorkflowsClient(() => {
        legacyDispatches += 1;
      }),
    );

    expect(legacyDispatches).toBe(1);
    expect(replacementEnqueues).toBe(0);
    expect(responseReferences).toBe(0);
  });

describe("status command workflow input", () => {
  it("keeps the provider token in the bot-owned capability record", () => {
    const input = makeStatusResponseReferenceInput({
      applicationId: "application-1",
      clientId: "client-1",
      interactionId: "123456789012345678",
      interactionToken: "provider-token",
    });

    expect(input).toEqual({
      applicationId: "application-1",
      client: { platform: "discord", clientId: "client-1" },
      interactionToken: "provider-token",
      permittedOperations: ["respond"],
      expiresAt: 1449505662216,
    });
  });
});

layer(statusEnqueueLayer)("status command workflow enqueue", (it) => {
  it.effect("explains that the service status check is owner-only", () =>
    Effect.gen(function* () {
      const capabilityStore = makeStatusCapabilityStore();
      const workflowClient = makeStatusWorkflowClient(() =>
        Effect.fail({
          _tag: "WorkflowInvocationUnauthorized" as const,
          message: "Workflow invocation is unauthorized",
        }),
      );
      const messages: Array<string | undefined> = [];
      const response = {
        editReply: ({ payload }: { readonly payload: { readonly content?: string } }) => {
          messages.push(payload.content);
          return Effect.void;
        },
      } as Pick<CommandInteractionResponseContext, "editReply">;

      yield* runStatusEnqueue(response, workflowClient, capabilityStore);

      expect(messages).toEqual(["Only the application owner can start the service status check."]);
    }),
  );

  it.effect("uses the capability store captured by the command layer", () =>
    Effect.gen(function* () {
      const capabilityStore = makeStatusCapabilityStore();
      const workflowClient = makeStatusWorkflowClient(((_, options) => {
        if (options?.invocationId === undefined) return Effect.die("invocation ID is required");
        return Effect.succeed({
          invocationId: options.invocationId,
          contractIdentity: "services.deliverStatus" as const,
          wireVersion: "1" as const,
        });
      }) satisfies ServicesDeliverStatusEnqueue);
      const response = {
        editReply: () => Effect.void,
      } as Pick<CommandInteractionResponseContext, "editReply">;

      yield* runStatusEnqueue(response, workflowClient, capabilityStore);
    }),
  );

  it.effect("uses the legacy path when the Rollout Gate selects it", () =>
    assertLegacyStatusFallback(() =>
      Effect.succeed({
        ...replacementStatusRolloutGateDecision,
        executionPath: "legacy" as const,
        reason: "legacy-enabled",
      }),
    ),
  );

  it.effect("uses the legacy path when Rollout Gate evaluation fails", () =>
    assertLegacyStatusFallback(() => Effect.fail(new Error("Rollout Gate Control is unavailable"))),
  );

  it.effect("uses the legacy path when Rollout Gate evaluation times out", () =>
    Effect.gen(function* () {
      let legacyDispatches = 0;
      const response = {
        editReply: () => Effect.void,
      } as Pick<CommandInteractionResponseContext, "editReply">;
      const fiber = yield* runStatusEnqueue(
        response,
        makeStatusWorkflowClient(
          () => Effect.succeed({}),
          () => Effect.never,
        ),
        makeStatusCapabilityStore(),
        makeStatusSheetWorkflowsClient(() => {
          legacyDispatches += 1;
        }),
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust(Duration.seconds(5));
      yield* Fiber.join(fiber);

      expect(legacyDispatches).toBe(1);
    }),
  );

  it.effect("preserves Rollout Gate evaluation defects and interruptions", () =>
    Effect.gen(function* () {
      const response = {
        editReply: () => Effect.void,
      } as Pick<CommandInteractionResponseContext, "editReply">;
      const defect = yield* Effect.exit(
        runStatusEnqueue(
          response,
          makeStatusWorkflowClient(
            () => Effect.succeed({}),
            () => Effect.die("Rollout Gate evaluation defect"),
          ),
          makeStatusCapabilityStore(),
        ),
      );
      const interrupted = yield* Effect.exit(
        runStatusEnqueue(
          response,
          makeStatusWorkflowClient(
            () => Effect.succeed({}),
            () => Effect.interrupt,
          ),
          makeStatusCapabilityStore(),
        ),
      );

      expect(defect._tag).toBe("Failure");
      expect(interrupted._tag).toBe("Failure");
      if (defect._tag === "Failure") {
        expect(Cause.squash(defect.cause)).toBe("Rollout Gate evaluation defect");
      }
      if (interrupted._tag === "Failure") {
        expect(Cause.hasInterrupts(interrupted.cause)).toBe(true);
      }
    }),
  );

  it.effect("reports a non-timeout legacy dispatch failure", () =>
    Effect.gen(function* () {
      const messages: Array<string | undefined> = [];
      const response = {
        editReply: ({ payload }: { readonly payload: { readonly content?: string } }) => {
          messages.push(payload.content);
          return Effect.void;
        },
      } as Pick<CommandInteractionResponseContext, "editReply">;
      const workflowClient = makeStatusWorkflowClient(
        () => Effect.succeed({}),
        () =>
          Effect.succeed({
            ...replacementStatusRolloutGateDecision,
            executionPath: "legacy" as const,
            reason: "legacy-enabled",
          }),
      );

      yield* runStatusEnqueue(
        response,
        workflowClient,
        makeStatusCapabilityStore(),
        makeStatusSheetWorkflowsClient(
          () => {},
          () => Effect.fail(new Error("legacy dispatch failed")),
        ),
      );

      expect(messages).toEqual(["I couldn't start the service status check. Please try again."]);
    }),
  );

  it.effect("passes a guild interaction as the Rollout Gate workspace scope", () =>
    Effect.gen(function* () {
      let evaluatedWorkspaceId: string | undefined;
      let issuedWorkspaceId: string | undefined;
      const workflowClient = makeStatusWorkflowClient(
        () => Effect.succeed({}),
        (input: { readonly workspaceId?: string }) => {
          evaluatedWorkspaceId = input.workspaceId;
          return Effect.succeed(replacementStatusRolloutGateDecision);
        },
      );
      const response = {
        editReply: () => Effect.void,
      } as Pick<CommandInteractionResponseContext, "editReply">;

      yield* runStatusEnqueue(
        response,
        workflowClient,
        makeStatusCapabilityStore((input) => {
          issuedWorkspaceId = input.workspaceId;
        }),
        undefined,
        "123456789012345678",
      );

      expect(evaluatedWorkspaceId).toBe("123456789012345678");
      expect(issuedWorkspaceId).toBe("123456789012345678");
    }),
  );
});
