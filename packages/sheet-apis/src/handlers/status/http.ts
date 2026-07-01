import { type HandlerMap, sheetApisGroupLayer } from "@/handlers/shared/httpApiLayer";
import { Effect, Layer } from "effect";
import { ServiceStatusService } from "@/services";

export const statusLayer = sheetApisGroupLayer(
  "status",
  Effect.gen(function* () {
    const serviceStatusService = yield* ServiceStatusService;

    return {
      "status.getServices": () => serviceStatusService.getServicesStatus(),
    } satisfies HandlerMap<"status">;
  }),
).pipe(Layer.provide(ServiceStatusService.layer));
