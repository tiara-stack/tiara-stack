import { Layer } from "effect";
import { actionContextSqlLayer } from "effect-zero-workflow";
import { makeUpdateAnnouncementDeliveryEntityLayer } from "@/entities/updateAnnouncementDelivery";
import {
  ClaimUpdateAnnouncementDeliveryAction,
  makeAnnouncementsDeliverUpdateDefinition,
} from "./definition";

const AnnouncementsDeliverUpdateDefinition = makeAnnouncementsDeliverUpdateDefinition();

const AnnouncementSheetWorkflowDefinitions = Object.freeze([
  AnnouncementsDeliverUpdateDefinition,
] as const);

const updateAnnouncementDeliveryEntityLayer = makeUpdateAnnouncementDeliveryEntityLayer({
  claim: ({ payload }) => ClaimUpdateAnnouncementDeliveryAction.await(payload),
});

const layers = [
  Layer.empty,
  ...AnnouncementSheetWorkflowDefinitions.flatMap(({ actions, workflowLayer }) => [
    ...actions.map((action) => action.toLayer()),
    workflowLayer,
  ]),
  updateAnnouncementDeliveryEntityLayer,
] as const;

export const announcementSheetWorkflowLayers = Layer.mergeAll(...layers).pipe(
  Layer.provide(actionContextSqlLayer),
);
