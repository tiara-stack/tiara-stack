import { DateTime, Effect } from "effect";
import { HealthRpcs } from "sheet-ingress-api/sheet-apis-rpc";
import { makeUnknownError } from "typhoon-core/error";
import { isWorkflowApiReady } from "@/services";

export const healthLayer = HealthRpcs.toLayer({
  "health.live": Effect.fnUntraced(function* () {
    const timestamp = yield* DateTime.now;
    return { status: "ok" as const, timestamp };
  }),
  "health.ready": Effect.fnUntraced(function* () {
    const ready = yield* isWorkflowApiReady;
    if (!ready) {
      return yield* Effect.fail(makeUnknownError("sheet-workflows services are not ready"));
    }

    const timestamp = yield* DateTime.now;
    return { status: "ok" as const, timestamp };
  }),
});
