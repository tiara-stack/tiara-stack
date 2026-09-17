import { Effect, Option, Stream } from "effect";
import type { ZeroClient } from "typhoon-zero/client";
import { ZeroApiClient } from "typhoon-zero/zeroApi";
import { materializeWorkflowRun } from "effect-zero-workflow/contract/server";
import {
  isRunReferenceFor,
  type RunReference,
  type WorkflowRun,
} from "effect-zero-workflow/contract";
import type { ZeroMaterializedWorkflowRunRow } from "effect-zero-workflow/contract/zero";
import {
  workflowContractZeroGroupIdentifier,
  WorkflowObservationUnauthorized,
  WorkflowTransportUnavailable,
  type WorkflowObservationError,
} from "effect-zero-workflow/contract/transport";
import {
  AuthorizationLoadWorkspaceCapabilities,
  CheckinMessagesLoad,
  CheckinMessagesSave,
} from "sheet-workflow-contracts";
import { SheetWorkflowZeroObservationApi, SheetZeroApi } from "./api";
import { mutators } from "./mutators";
import { clientWorkflowObservationQueries, queries } from "./queries";
import type { Schema } from "./schema";
import type { SheetWorkflowZeroObservationContract } from "./workflows";

/**
 * Application-facing Sheet client. Its root is intentionally not workflow-
 * specific: references can point at ordinary reactive data or mutations, while
 * durable execution remains an implementation detail of selected operations.
 */
export type SheetClient = ZeroApiClient.FunctionClient<typeof SheetZeroApi, "public">;

export const makeSheetClient = <Context>(
  zeroClient: ZeroClient.ZeroClientExecutor<Schema, Context>,
): Effect.Effect<SheetClient> =>
  ZeroApiClient.makeFunctionsWithService(SheetZeroApi, zeroClient, {
    queries,
    mutators,
  });

export type WorkflowZeroObserver<Contract extends SheetWorkflowZeroObservationContract> = {
  readonly get: (
    reference: unknown,
  ) => Stream.Stream<Option.Option<WorkflowRun<Contract>>, WorkflowObservationError>;
};

export type CheckinMessagesLoadZeroObserver = WorkflowZeroObserver<typeof CheckinMessagesLoad>;
export type CheckinMessagesSaveZeroObserver = WorkflowZeroObserver<typeof CheckinMessagesSave>;
export type AuthorizationLoadWorkspaceCapabilitiesZeroObserver = WorkflowZeroObserver<
  typeof AuthorizationLoadWorkspaceCapabilities
>;

export const workflowObservationUnavailable = () =>
  new WorkflowTransportUnavailable({
    operation: "Observe",
    retryable: true,
    message: "Workflow observation transport is unavailable",
  });

export const workflowObservationUnauthorized = () =>
  new WorkflowObservationUnauthorized({
    message: "Workflow observation authorization is no longer valid",
  });

export const makeWorkflowZeroObserver = <
  Contract extends SheetWorkflowZeroObservationContract,
  Context,
>(
  contract: Contract,
  zeroClient: ZeroClient.ZeroClientExecutor<Schema, Context>,
): Effect.Effect<WorkflowZeroObserver<Contract>> =>
  Effect.map(
    ZeroApiClient.makeFunctionsWithService(SheetWorkflowZeroObservationApi, zeroClient, {
      queries: clientWorkflowObservationQueries,
    }),
    (client) => {
      type QueryGroup = {
        readonly get: {
          readonly stream: (
            reference: RunReference<Contract>,
          ) => Stream.Stream<Option.Option<ZeroMaterializedWorkflowRunRow>, unknown>;
        };
      };
      const group = (client.grouped as unknown as Readonly<Record<string, QueryGroup | undefined>>)[
        workflowContractZeroGroupIdentifier(contract)
      ];
      if (group === undefined) {
        throw new Error(`Workflow observation query is not mounted: ${contract.identity}`);
      }
      const query = group.get;
      return {
        get: (reference) =>
          (isRunReferenceFor(contract, reference)
            ? query.stream(reference)
            : Stream.succeed(Option.none<ZeroMaterializedWorkflowRunRow>())
          ).pipe(
            Stream.mapError(workflowObservationUnavailable),
            Stream.mapEffect((row) =>
              Option.match(row, {
                onNone: () => Effect.succeed(Option.none<WorkflowRun<Contract>>()),
                onSome: (materialized) =>
                  materializeWorkflowRun(contract, materialized).pipe(Effect.map(Option.some)),
              }),
            ),
          ),
      };
    },
  );

export const makeCheckinMessagesLoadZeroObserver = <Context>(
  zeroClient: ZeroClient.ZeroClientExecutor<Schema, Context>,
): Effect.Effect<CheckinMessagesLoadZeroObserver> =>
  makeWorkflowZeroObserver(CheckinMessagesLoad, zeroClient);

export const makeCheckinMessagesSaveZeroObserver = <Context>(
  zeroClient: ZeroClient.ZeroClientExecutor<Schema, Context>,
): Effect.Effect<CheckinMessagesSaveZeroObserver> =>
  makeWorkflowZeroObserver(CheckinMessagesSave, zeroClient);

export const makeAuthorizationLoadWorkspaceCapabilitiesZeroObserver = <Context>(
  zeroClient: ZeroClient.ZeroClientExecutor<Schema, Context>,
): Effect.Effect<AuthorizationLoadWorkspaceCapabilitiesZeroObserver> =>
  makeWorkflowZeroObserver(AuthorizationLoadWorkspaceCapabilities, zeroClient);
