import { Effect, Layer } from "effect";
import { actionContextSqlLayer } from "effect-zero-workflow";
import { makeCheckinProjectionEntityLayer } from "@/entities/checkinProjection";
import {
  EditCheckinMessageAction,
  LoadCurrentCheckinViewAction,
  makeCheckinsRespondDefinition,
} from "./definition";
import { makeCheckinsTestAutoDefinition } from "./autoTestDefinition";
import { makeCheckinsOpenDefinition } from "./openDefinition";

const CheckinsOpenDefinition = makeCheckinsOpenDefinition();
const CheckinsRespondDefinition = makeCheckinsRespondDefinition();
const CheckinsTestAutoDefinition = makeCheckinsTestAutoDefinition();

export const CheckinSheetWorkflowDefinitions = Object.freeze([
  CheckinsOpenDefinition,
  CheckinsRespondDefinition,
  CheckinsTestAutoDefinition,
] as const);

export const CheckinSheetWorkflows = Object.freeze(
  CheckinSheetWorkflowDefinitions.map(({ workflow }) => workflow),
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
  CheckinsOpenDefinition.entityLayer,
] as const;

export const checkinSheetWorkflowLayers = Layer.mergeAll(...checkinSheetWorkflowLayerList).pipe(
  Layer.provide(actionContextSqlLayer),
);
