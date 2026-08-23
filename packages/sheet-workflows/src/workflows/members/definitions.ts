import { Cause, Layer, Schema } from "effect";
import type { WorkflowDefinition, WorkflowJson } from "effect-zero-workflow";
import { actionContextSqlLayer } from "effect-zero-workflow";
import { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import { makeMemberKickEntityLayer } from "@/entities/memberKick";
import { materializeWorkflowFailure } from "../shared/failure";
import { makeMembersKickDefinition, runMembersKickSerialized } from "./definition";

const MembersKickDefinition = makeMembersKickDefinition();

const MemberSheetWorkflowDefinitions = Object.freeze([MembersKickDefinition] as const);

export const MemberSheetWorkflows = Object.freeze(
  MemberSheetWorkflowDefinitions.map(({ workflow }) => workflow as WorkflowDefinition),
);

const memberSheetWorkflowNames = new Set(MemberSheetWorkflows.map(({ name }) => name));

export const isMemberSheetWorkflowName = (workflowName: string): boolean =>
  memberSheetWorkflowNames.has(workflowName);

export const materializeMemberWorkflowFailure = (
  _workflow: WorkflowDefinition,
  cause: Cause.Cause<unknown>,
): WorkflowJson => materializeWorkflowFailure(Schema.is(InteractiveDeclaredFailure), cause);

const memberKickEntityLayer = makeMemberKickEntityLayer({
  run: ({ payload }) => runMembersKickSerialized(payload),
});

const layers = [
  Layer.empty,
  ...MemberSheetWorkflowDefinitions.flatMap(({ actions, workflowLayer }) => [
    ...actions.map((action) => action.toLayer()),
    workflowLayer,
  ]),
  memberKickEntityLayer,
] as const;

export const memberSheetWorkflowLayers = Layer.mergeAll(...layers).pipe(
  Layer.provide(actionContextSqlLayer),
);
