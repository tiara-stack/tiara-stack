import { Effect, Layer } from "effect";
import { CheckinRpcs } from "sheet-ingress-api/sheet-apis-rpc";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { normalizeDispatchError } from "@/handlers/shared/dispatchError";
import { withCurrentGuildAuthFromPayload } from "@/handlers/shared/guildAuthorization";
import { requireMessageCheckinParticipantMutationAccess } from "@/handlers/messageCheckin/http";
import {
  AuthorizationService,
  CheckinService,
  DispatchService,
  MessageCheckinService,
} from "@/services";

export const checkinLayer = CheckinRpcs.toLayer(
  Effect.gen(function* () {
    const authorizationService = yield* AuthorizationService;
    const checkinService = yield* CheckinService;
    const dispatchService = yield* DispatchService;
    const messageCheckinService = yield* MessageCheckinService;
    const withPayloadGuildAuth = withCurrentGuildAuthFromPayload(authorizationService);

    return {
      "checkin.generate": withPayloadGuildAuth(
        Effect.fnUntraced(function* ({ payload }) {
          yield* authorizationService.requireMonitorGuild(payload.guildId);
          return yield* checkinService.generate(payload);
        }),
      ),
      "checkin.dispatch": withPayloadGuildAuth(
        Effect.fnUntraced(function* ({ payload }) {
          // withPayloadGuildAuth provides guild-scoped auth context; this enforces monitor access.
          yield* authorizationService.requireMonitorGuild(payload.guildId);
          return yield* dispatchService
            .checkin(payload)
            .pipe(Effect.mapError(normalizeDispatchError("Failed to dispatch check-in")));
        }),
      ),
      "checkin.handleButton": Effect.fnUntraced(function* ({ payload }) {
        return yield* Effect.gen(function* () {
          const user = yield* SheetAuthUser;
          yield* requireMessageCheckinParticipantMutationAccess(
            authorizationService,
            messageCheckinService,
            payload.messageId,
            user.accountId,
          );
          return yield* dispatchService
            .checkinButton(payload)
            .pipe(Effect.mapError(normalizeDispatchError("Failed to handle check-in button")));
        }).pipe(Effect.mapError(normalizeDispatchError("Failed to authorize check-in button")));
      }),
    };
  }),
).pipe(
  Layer.provide([
    AuthorizationService.layer,
    CheckinService.layer,
    DispatchService.layer,
    MessageCheckinService.layer,
  ]),
);
