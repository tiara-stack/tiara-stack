import { Effect, Layer, Option } from "effect";
import { RoomOrderRpcs } from "sheet-ingress-api/sheet-apis-rpc";
import { makeArgumentError } from "typhoon-core/error";
import { requireRoomOrderMonitorAccess } from "@/handlers/messageRoomOrder/http";
import { normalizeDispatchError } from "@/handlers/shared/dispatchError";
import { withCurrentGuildAuthFromPayload } from "@/handlers/shared/guildAuthorization";
import {
  AuthorizationService,
  DispatchService,
  MessageRoomOrderService,
  RoomOrderService,
} from "@/services";

export const roomOrderLayer = RoomOrderRpcs.toLayer(
  Effect.gen(function* () {
    const authorizationService = yield* AuthorizationService;
    const dispatchService = yield* DispatchService;
    const messageRoomOrderService = yield* MessageRoomOrderService;
    const roomOrderService = yield* RoomOrderService;
    const withPayloadGuildAuth = withCurrentGuildAuthFromPayload(authorizationService);

    return {
      "roomOrder.generate": withPayloadGuildAuth(
        Effect.fnUntraced(function* ({ payload }) {
          yield* authorizationService.requireMonitorGuild(payload.guildId);
          return yield* roomOrderService.generate(payload);
        }),
      ),
      "roomOrder.dispatch": withPayloadGuildAuth(
        Effect.fnUntraced(function* ({ payload }) {
          // withPayloadGuildAuth provides guild-scoped auth context; this enforces monitor access.
          yield* authorizationService.requireMonitorGuild(payload.guildId);
          return yield* dispatchService
            .roomOrder(payload)
            .pipe(Effect.mapError(normalizeDispatchError("Failed to dispatch room order")));
        }),
      ),
      "roomOrder.handleButton": Effect.fnUntraced(function* ({ payload }) {
        return yield* Effect.gen(function* () {
          const record = yield* messageRoomOrderService.getMessageRoomOrder(payload.messageId);
          if (Option.isNone(record)) {
            if (payload.action !== "pinTentative") {
              return yield* Effect.fail(
                makeArgumentError("Cannot handle room-order button, message is not registered"),
              );
            }
            return yield* withPayloadGuildAuth(
              Effect.fnUntraced(function* ({ payload }) {
                yield* authorizationService.requireMonitorGuild(payload.guildId);
                return yield* dispatchService
                  .roomOrderButton(payload)
                  .pipe(
                    Effect.mapError(normalizeDispatchError("Failed to handle room-order button")),
                  );
              }),
            )({ payload });
          }
          yield* requireRoomOrderMonitorAccess(authorizationService, record.value);
          return yield* dispatchService
            .roomOrderButton(payload)
            .pipe(Effect.mapError(normalizeDispatchError("Failed to handle room-order button")));
        }).pipe(Effect.mapError(normalizeDispatchError("Failed to authorize room-order button")));
      }),
    };
  }),
).pipe(
  Layer.provide([
    AuthorizationService.layer,
    DispatchService.layer,
    MessageRoomOrderService.layer,
    RoomOrderService.layer,
  ]),
);
