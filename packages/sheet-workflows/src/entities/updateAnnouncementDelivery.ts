import { type Effect, Layer } from "effect";
import { ClusterSchema, Entity } from "effect/unstable/cluster";
import { Rpc } from "effect/unstable/rpc";
import { AutonomousDeclaredFailure } from "sheet-workflow-contracts";
import {
  UpdateAnnouncementClaim,
  UpdateAnnouncementExecution,
} from "@/workflows/announcements/schema";

export const UpdateAnnouncementDeliveryEntity = Entity.make("UpdateAnnouncementDelivery", [
  Rpc.make("claim", {
    payload: UpdateAnnouncementExecution,
    success: UpdateAnnouncementClaim,
    error: AutonomousDeclaredFailure,
  }),
]).annotate(ClusterSchema.ShardGroup, () => "dispatch");

export type UpdateAnnouncementDeliveryClaimRequest = {
  readonly payload: typeof UpdateAnnouncementExecution.Type;
};

export const makeUpdateAnnouncementDeliveryEntityLayer = <R>(handler: {
  readonly claim: (
    request: UpdateAnnouncementDeliveryClaimRequest,
  ) => Effect.Effect<typeof UpdateAnnouncementClaim.Type, typeof AutonomousDeclaredFailure.Type, R>;
}) =>
  UpdateAnnouncementDeliveryEntity.toLayer(UpdateAnnouncementDeliveryEntity.of(handler), {
    maxIdleTime: "5 minutes",
    concurrency: 1,
  }).pipe(Layer.withSpan("sheet-workflows.updateAnnouncementDeliveryEntity"));
