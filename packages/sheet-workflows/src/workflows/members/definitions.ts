import { Layer } from "effect";
import { actionContextSqlLayer } from "effect-zero-workflow";
import { makeMemberKickEntityLayer } from "@/entities/memberKick";
import { makeMembersKickDefinition, runMembersKickSerialized } from "./definition";

const MembersKickDefinition = makeMembersKickDefinition();

const MemberSheetWorkflowDefinitions = Object.freeze([MembersKickDefinition] as const);

export const MemberSheetWorkflows = Object.freeze(
  MemberSheetWorkflowDefinitions.map(({ workflow }) => workflow),
);

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
