import { type Effect, Layer } from "effect";
import { ClusterSchema, Entity } from "effect/unstable/cluster";
import { Rpc } from "effect/unstable/rpc";
import { InteractiveDeclaredFailure, MembersKick } from "sheet-workflow-contracts";
import { MemberKickResolvedExecution } from "@/workflows/members/schema";

export const MemberKickEntity = Entity.make("MemberKick", [
  Rpc.make("run", {
    payload: MemberKickResolvedExecution,
    success: MembersKick.success,
    error: InteractiveDeclaredFailure,
  }),
]).annotate(ClusterSchema.ShardGroup, () => "dispatch");

export type MemberKickRunRequest = {
  readonly payload: typeof MemberKickResolvedExecution.Type;
};

export const makeMemberKickEntityLayer = <R>(handler: {
  readonly run: (
    request: MemberKickRunRequest,
  ) => Effect.Effect<typeof MembersKick.success.Type, typeof InteractiveDeclaredFailure.Type, R>;
}) =>
  MemberKickEntity.toLayer(MemberKickEntity.of(handler), {
    maxIdleTime: "5 minutes",
    concurrency: 1,
  }).pipe(Layer.withSpan("sheet-workflows.memberKickEntity"));
