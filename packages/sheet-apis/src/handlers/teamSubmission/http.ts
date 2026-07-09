import { Effect, Layer } from "effect";
import { type HandlerMap, sheetApisGroupLayer } from "@/handlers/shared/httpApiLayer";
import { AuthorizationService, TeamSubmissionService } from "@/services";

export const teamSubmissionLayer = sheetApisGroupLayer(
  "teamSubmission",
  Effect.gen(function* () {
    const authorizationService = yield* AuthorizationService;
    const teamSubmissionService = yield* TeamSubmissionService;

    return {
      "teamSubmission.upsertFromDiscord": Effect.fnUntraced(function* ({ payload }) {
        yield* authorizationService.requireService();
        return yield* teamSubmissionService.upsertFromDiscord(payload);
      }),
      "teamSubmission.setConfirmationMessage": Effect.fnUntraced(function* ({ payload }) {
        yield* authorizationService.requireService();
        return yield* teamSubmissionService.setConfirmationMessage(payload);
      }),
      "teamSubmission.revertFromDiscord": Effect.fnUntraced(function* ({ payload }) {
        yield* authorizationService.requireService();
        return yield* teamSubmissionService.revertFromDiscord(payload);
      }),
      "teamSubmission.confirmFromDiscord": Effect.fnUntraced(function* ({ payload }) {
        yield* authorizationService.requireService();
        return yield* teamSubmissionService.confirmFromDiscord(payload);
      }),
    } satisfies HandlerMap<"teamSubmission">;
  }),
).pipe(Layer.provide([AuthorizationService.layer, TeamSubmissionService.layer]));
