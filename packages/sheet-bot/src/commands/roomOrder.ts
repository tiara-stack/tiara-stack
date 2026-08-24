import { MessageFlags } from "discord-api-types/v10";
import {
  CommandHelper,
  InteractionResponse,
  type CommandInteractionResponseContext,
} from "dfx-discord-utils/utils";
import { Duration, Effect, Layer, Match, Schema } from "effect";
import { makeWorkflowInvocationId } from "sheet-workflow-http-client";
import { WorkspaceId } from "sheet-workflow-contracts/values";
import {
  BotCapabilityStore,
  enqueueRoomOrdersCreateWorkflow,
  SheetWorkflowHttpClient,
  SheetWorkflowHttpRequestContext,
  SheetWorkflowsClient,
  SheetWorkflowsRequestContext,
  type RoomOrdersCreateInput,
  type SheetWorkflowHttpClientShape,
  type SheetWorkflowsClientShape,
} from "../services";
import { config } from "../config";
import { prefixedUnstorageLayer } from "../discord/cache";
import {
  makeDispatchBase,
  makeWorkflowEnqueueFailureReporter,
  optionalPayloadField,
  optionalNumberValue,
  optionalStringValue,
  resolveConversationTarget,
} from "../utils/commandHelpers";
import { registerSingleSubCommandLayer } from "../utils/registerGlobalCommandLayer";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";
import {
  enqueueReplacementWorkflow,
  evaluateRolloutGateWithLegacyFallback,
} from "../utils/workflowEnqueue";

const roomOrderEnqueueRejectedMessage = "I couldn't start the room order. Please try again.";
const roomOrderEnqueueUnauthorizedMessage = "You aren't allowed to create a room order.";
const roomOrderEnqueuePendingMessage =
  "The room order is still processing. I'll update this message when it finishes.";
const roomOrderRolloutGateEvaluationTimeout = Duration.seconds(5);

type RoomOrderRolloutGateDecision = Effect.Success<
  ReturnType<SheetWorkflowHttpClientShape["evaluateRoomOrdersCreateRolloutGate"]>
>;
type RoomOrderCommandInput = Omit<RoomOrdersCreateInput, "responseReference" | "workspaceId"> & {
  readonly workspaceId: string;
};

const roomOrderGateUnavailableDecision: RoomOrderRolloutGateDecision = {
  gateKey: "unavailable",
  revision: 0,
  matched: false,
  executionPath: "legacy",
  reason: "control-unavailable",
};

const reportDefinitiveEnqueueFailure = makeWorkflowEnqueueFailureReporter({
  logMessage: "Sheet-bot room-order workflow enqueue was rejected",
  rejectedMessage: roomOrderEnqueueRejectedMessage,
  unauthorizedMessage: roomOrderEnqueueUnauthorizedMessage,
});

const dispatchLegacyRoomOrder = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  input: RoomOrderCommandInput,
) =>
  runSheetWorkflowsDispatch(
    response,
    "the room order",
    SheetWorkflowsRequestContext.asInteractionUser(
      Effect.fn("roomOrder.dispatchLegacyPath")(function* () {
        const base = yield* makeDispatchBase;
        return yield* sheetWorkflowsClient.get().dispatch.roomOrder({
          payload: { ...base, ...input },
        });
      }),
    )(),
  ).pipe(Effect.catch((error) => reportDefinitiveEnqueueFailure(response, error)));

export const enqueueRoomOrder = Effect.fn("roomOrder.enqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<
    SheetWorkflowHttpClientShape,
    "enqueueRoomOrdersCreate" | "evaluateRoomOrdersCreateRolloutGate"
  >,
  sheetWorkflowsClient: SheetWorkflowsClientShape,
  capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">,
  input: Omit<RoomOrdersCreateInput, "responseReference">,
  legacyInput: RoomOrderCommandInput,
) {
  const invocationId = yield* makeWorkflowInvocationId();
  const clientId = yield* config.sheetBotClientId;
  const decision = yield* evaluateRolloutGateWithLegacyFallback(
    SheetWorkflowHttpRequestContext.asInteractionUser(() =>
      workflowClient.evaluateRoomOrdersCreateRolloutGate({
        contractIdentity: "roomOrders.create",
        contractWireVersion: "1",
        client: { platform: "discord", clientId },
        invocationId,
        workspaceId: input.workspaceId,
      }),
    )(),
    roomOrderRolloutGateEvaluationTimeout,
    roomOrderGateUnavailableDecision,
    invocationId,
  );

  yield* Match.value(decision.executionPath).pipe(
    Match.when("legacy", () =>
      dispatchLegacyRoomOrder(response, sheetWorkflowsClient, legacyInput),
    ),
    Match.when("replacement", () =>
      enqueueReplacementWorkflow(
        response,
        capabilityStore,
        input.workspaceId,
        invocationId,
        (responseReference, invocationId) =>
          enqueueRoomOrdersCreateWorkflow(
            workflowClient,
            { ...input, responseReference },
            { invocationId },
          ),
        "Sheet-bot room-order workflow enqueue outcome is ambiguous",
        roomOrderEnqueuePendingMessage,
        (error) => reportDefinitiveEnqueueFailure(response, error),
      ),
    ),
    Match.exhaustive,
  );
});

const makeManualSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("manual")
        .setDescription("Manual room order commands")
        .addStringOption((option) =>
          option.setName("channel_name").setDescription("The name of the running channel"),
        )
        .addNumberOption((option) =>
          option.setName("hour").setDescription("The hour to order rooms for"),
        )
        .addNumberOption((option) => option.setName("heal").setDescription("The healer needed"))
        .addStringOption((option) =>
          option.setName("server_id").setDescription("The server to order rooms for"),
        ),
    Effect.fn("room_order.manual")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply({ flags: MessageFlags.Ephemeral });

      const target = yield* resolveConversationTarget(
        optionalStringValue(command.optionValueOptional("server_id")),
        optionalStringValue(command.optionValueOptional("channel_name")),
      );
      const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(target.workspaceId);
      const optionalFields = {
        ...optionalPayloadField("hour", optionalNumberValue(command.optionValueOptional("hour"))),
        ...optionalPayloadField(
          "healNeeded",
          optionalNumberValue(command.optionValueOptional("heal")),
        ),
      };
      const input = { ...target, ...optionalFields, workspaceId };

      yield* enqueueRoomOrder(
        response,
        workflowClient,
        sheetWorkflowsClient,
        capabilityStore,
        input,
        { ...target, ...optionalFields },
      );
    }),
  );
});

export const roomOrderCommandLayer = registerSingleSubCommandLayer({
  commandName: "room_order",
  commandDescription: "Room order commands",
  subCommandName: "manual",
  makeSubCommand: makeManualSubCommand,
}).pipe(
  Layer.provide(
    Layer.mergeAll(
      SheetWorkflowHttpClient.layer,
      BotCapabilityStore.layer.pipe(Layer.provide(prefixedUnstorageLayer)),
    ),
  ),
);
