import { DateTime, Effect } from "effect";
import { sheetApisGroupLayer } from "@/handlers/shared/httpApiLayer";

export const healthLayer = sheetApisGroupLayer("health", {
  "health.live": Effect.fnUntraced(function* () {
    const timestamp = yield* DateTime.now;
    return { status: "ok" as const, timestamp };
  }),
  "health.ready": Effect.fnUntraced(function* () {
    const timestamp = yield* DateTime.now;
    return { status: "ok" as const, timestamp };
  }),
});
