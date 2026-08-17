import { Cause, Effect, Layer, Schema } from "effect";
import type { WorkflowDefinition, WorkflowJson } from "effect-zero-workflow";
import { actionContextSqlLayer } from "effect-zero-workflow";
import { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import { makeCheckinProjectionEntityLayer } from "@/entities/checkinProjection";
import { materializeWorkflowFailure } from "../shared/failure";
import {
  EditCheckinMessageAction,
  LoadCurrentCheckinViewAction,
  makeCheckinsRespondDefinition,
} from "./definition";
import { makeCheckinsTestAutoDefinition } from "./autoTestDefinition";

const CheckinsRespondDefinition = makeCheckinsRespondDefinition();
const CheckinsTestAutoDefinition = makeCheckinsTestAutoDefinition();

export const CheckinSheetWorkflowDefinitions = Object.freeze([
  CheckinsRespondDefinition,
  CheckinsTestAutoDefinition,
] as const);

export const CheckinSheetWorkflows = Object.freeze(
  CheckinSheetWorkflowDefinitions.map(({ workflow }) => workflow as WorkflowDefinition),
);

const checkinSheetWorkflowNames = new Set(CheckinSheetWorkflows.map(({ name }) => name));

export const isCheckinSheetWorkflowName = (workflowName: string): boolean =>
  checkinSheetWorkflowNames.has(workflowName);

const checkinProjectionEntityLayer = makeCheckinProjectionEntityLayer({
  project: ({ payload }) =>
    Effect.gen(function* () {
      // The entity holds the canonical message key while these separately replayable
      // Durable Actions run, preventing an older loaded view from publishing last.
      const view = yield* LoadCurrentCheckinViewAction.await(payload);
      return yield* EditCheckinMessageAction.await({ ...payload, view });
    }),
});

const checkinSheetWorkflowLayerList = [
  Layer.empty,
  ...CheckinSheetWorkflowDefinitions.flatMap(({ actions, workflowLayer }) => [
    ...actions.map((action) => action.toLayer()),
    workflowLayer,
  ]),
  checkinProjectionEntityLayer,
] as const;

export const checkinSheetWorkflowLayers = Layer.mergeAll(...checkinSheetWorkflowLayerList).pipe(
  Layer.provide(actionContextSqlLayer),
);

export const materializeCheckinWorkflowFailure = (
  _workflow: WorkflowDefinition,
  cause: Cause.Cause<unknown>,
): WorkflowJson => materializeWorkflowFailure(Schema.is(InteractiveDeclaredFailure), cause);
