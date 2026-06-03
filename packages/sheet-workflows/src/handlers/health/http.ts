import { DateTime, Effect } from "effect";
import { HealthRpcs } from "sheet-ingress-api/sheet-apis-rpc";
import { makeUnknownError } from "typhoon-core/error";
import { isClusterRunnerReady } from "@/services";

export const healthLayer = HealthRpcs.toLayer({
  "health.live": Effect.fnUntraced(function* () {
    const timestamp = yield* DateTime.now;
    return { status: "ok" as const, timestamp };
  }),
  "health.ready": Effect.fnUntraced(function* () {
    const ready = yield* isClusterRunnerReady;
    if (!ready) {
      return yield* Effect.fail(makeUnknownError("sheet-workflows runner is not ready"));
    }

    const timestamp = yield* DateTime.now;
    return { status: "ok" as const, timestamp };
  }),
});
