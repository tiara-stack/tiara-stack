import { DateTime, Effect } from "effect";
import { type HandlerMap, sheetApisGroupLayer } from "@/handlers/shared/httpApiLayer";

export const healthLayer = sheetApisGroupLayer("health", {
  "health.live": Effect.fnUntraced(function* () {
    const timestamp = yield* DateTime.now;
    return { status: "ok" as const, timestamp };
  }),
  "health.ready": Effect.fnUntraced(function* () {
    const timestamp = yield* DateTime.now;
    return { status: "ok" as const, timestamp };
  }),
} satisfies HandlerMap<"health">);
