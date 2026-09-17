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
import { CheckinMessagesLoad } from "sheet-workflow-contracts";
import { SheetWorkflowZeroObservationApi, SheetZeroApi } from "./api";
import { mutators } from "./mutators";
import { clientWorkflowObservationQueries, queries } from "./queries";
import type { Schema } from "./schema";

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

export type CheckinMessagesLoadZeroObserver = {
  readonly get: (
    reference: unknown,
  ) => Stream.Stream<
    Option.Option<WorkflowRun<typeof CheckinMessagesLoad>>,
    WorkflowObservationError
  >;
};

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

export const makeCheckinMessagesLoadZeroObserver = <Context>(
  zeroClient: ZeroClient.ZeroClientExecutor<Schema, Context>,
): Effect.Effect<CheckinMessagesLoadZeroObserver> =>
  Effect.map(
    ZeroApiClient.makeFunctionsWithService(SheetWorkflowZeroObservationApi, zeroClient, {
      queries: clientWorkflowObservationQueries,
    }),
    (client) => {
      type QueryGroup = {
        readonly get: {
          readonly stream: (
            reference: RunReference<typeof CheckinMessagesLoad>,
          ) => Stream.Stream<Option.Option<ZeroMaterializedWorkflowRunRow>, unknown>;
        };
      };
      const group = (client.grouped as unknown as Readonly<Record<string, QueryGroup | undefined>>)[
        workflowContractZeroGroupIdentifier(CheckinMessagesLoad)
      ];
      if (group === undefined) {
        throw new Error("Check-in message load observation query is not mounted");
      }
      const query = group.get;
      return {
        get: (reference) =>
          (isRunReferenceFor(CheckinMessagesLoad, reference)
            ? query.stream(reference)
            : Stream.succeed(Option.none<ZeroMaterializedWorkflowRunRow>())
          ).pipe(
            Stream.mapError(workflowObservationUnavailable),
            Stream.mapEffect((row) =>
              Option.match(row, {
                onNone: () =>
                  Effect.succeed(Option.none<WorkflowRun<typeof CheckinMessagesLoad>>()),
                onSome: (materialized) =>
                  materializeWorkflowRun(CheckinMessagesLoad, materialized).pipe(
                    Effect.map(Option.some),
                  ),
              }),
            ),
          ),
      };
    },
  );
