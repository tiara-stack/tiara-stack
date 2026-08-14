import { Effect, Match, Predicate, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { BotOutboundMessage, RespondReceipt } from "sheet-bot-api";
import * as MessageText from "sheet-message-content/text";
import { formatServiceStatusFieldValue, makeEmbed } from "sheet-message-content/rendering";
import { InteractiveDeclaredFailure, ServicesDeliverStatus } from "sheet-workflow-contracts";
import {
  decodeWorkflowContractInputOrDie,
  workflowContractExecutionSchema,
} from "../shared/execution";
import {
  authorizeInteractiveWorkflow as authorize,
  preserveInteractiveDeclaredFailure as preserveDeclaredFailure,
} from "../shared/interactive";
import { serviceSheetWorkflowDefinitionVersion } from "./catalog";
import { makeServiceStatusDeliveryKey } from "./keys";
import { ServiceReadinessSnapshot } from "./schema";
import { ServiceStatusWorkflowOperations } from "./service";

const name = workflowContractKey(ServicesDeliverStatus);
const actionName = ServicesDeliverStatus.identity;
const executionSchema = workflowContractExecutionSchema(ServicesDeliverStatus);
const deliveryExecutionSchema = Schema.Struct({
  ...executionSchema.fields,
  snapshot: ServiceReadinessSnapshot,
  message: BotOutboundMessage,
});

export const makeServicesDeliverStatusMessage = (
  snapshot: ServiceReadinessSnapshot,
): typeof BotOutboundMessage.Type => ({
  embeds: [
    makeEmbed({
      title: "Service Status",
      description: MessageText.parts(
        MessageText.text(
          snapshot.overallStatus === "ok"
            ? "All services are ready."
            : "Some services are not ready.",
        ),
        MessageText.text("\nChecked at "),
        MessageText.timestamp(snapshot.checkedAt.epochMilliseconds),
      ),
      color: snapshot.overallStatus === "ok" ? 0x57f287 : 0xfee75c,
      fields: snapshot.services.map((service) => ({
        name: service.service,
        value: formatServiceStatusFieldValue({
          ...service,
          name: service.service,
          error: Predicate.isNotNull(service.httpStatus)
            ? null
            : Match.value(service.error).pipe(
                Match.when("timeout", () => "timeout" as const),
                Match.orElse(() => "request failed" as const),
              ),
        }),
        inline: true,
      })),
    }),
  ],
  allowedMentions: "none",
});

export const executeCollectServiceReadinessAction = (execution: typeof executionSchema.Type) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(ServicesDeliverStatus, execution));
    const operations = yield* ServiceStatusWorkflowOperations;
    return yield* preserveDeclaredFailure(operations.collectReadiness());
  });

export const executeDeliverServiceStatusAction = (execution: typeof deliveryExecutionSchema.Type) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(ServicesDeliverStatus, execution));
    const operations = yield* ServiceStatusWorkflowOperations;
    const input = yield* decodeWorkflowContractInputOrDie(ServicesDeliverStatus, execution.input);
    return yield* preserveDeclaredFailure(
      operations.respond(
        input,
        execution.message,
        makeServiceStatusDeliveryKey(execution.invocationId),
        ServicesDeliverStatus.authorizationPolicy.policy,
      ),
    );
  });

const CollectServiceReadinessAction = makeAction({
  name: `${actionName}.collect-service-readiness`,
  version: serviceSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: executionSchema,
  success: ServiceReadinessSnapshot,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeCollectServiceReadinessAction,
});

const DeliverServiceStatusAction = makeAction({
  name: `${actionName}.deliver-service-status`,
  version: serviceSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: deliveryExecutionSchema,
  success: RespondReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeDeliverServiceStatusAction,
});

const ServicesDeliverStatusWorkflow = Workflow.make({
  name,
  payload: executionSchema,
  success: ServicesDeliverStatus.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

export const makeServicesDeliverStatusWorkflowBody = <E, R>(actions: {
  readonly collect: (
    execution: typeof executionSchema.Type,
  ) => Effect.Effect<ServiceReadinessSnapshot, E, R>;
  readonly deliver: (
    execution: typeof deliveryExecutionSchema.Type,
  ) => Effect.Effect<typeof RespondReceipt.Type, E, R>;
}) =>
  Effect.fnUntraced(function* (execution: typeof executionSchema.Type) {
    yield* decodeWorkflowContractInputOrDie(ServicesDeliverStatus, execution.input);
    const snapshot = yield* actions.collect(execution);
    const receipt = yield* actions.deliver({
      ...execution,
      snapshot,
      message: makeServicesDeliverStatusMessage(snapshot),
    });
    const okCount = snapshot.services.filter(({ status }) => status === "ok").length;
    return {
      overallStatus: snapshot.overallStatus,
      okCount,
      downCount: snapshot.services.length - okCount,
      services: snapshot.services.map(({ service, status }) => ({ service, status })),
      deliveryReceipts: [receipt],
    };
  });

export const makeServicesDeliverStatusDefinition = () => ({
  contract: ServicesDeliverStatus,
  workflow: ServicesDeliverStatusWorkflow,
  actions: [CollectServiceReadinessAction, DeliverServiceStatusAction] as const,
  workflowLayer: ServicesDeliverStatusWorkflow.toLayer(
    makeServicesDeliverStatusWorkflowBody({
      collect: (execution) => CollectServiceReadinessAction.await(execution),
      deliver: (execution) => DeliverServiceStatusAction.await(execution),
    }),
  ),
});
