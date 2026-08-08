import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Clock,
  ConfigProvider,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { Unstorage } from "dfx-discord-utils/discord/cache";
import {
  BotDependencyUnavailable,
  BotRequestRejected,
  DeliveryKey,
  type DeliveryReceipt,
} from "sheet-bot-api";
import { makeBotCapabilityStore } from "./botCapabilityStore";

const configLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    SHEET_BOT_CAPABILITY_ENCRYPTION_SECRET: "test-sheet-bot-capability-encryption-secret",
  }),
);

const client = { platform: "discord", clientId: "discord-main" } as const;
const conversation = {
  workspace: { client, workspaceId: "workspace-1" },
  conversationId: "conversation-1",
} as const;

const deliveryKey = (value: string) => Schema.decodeUnknownSync(DeliveryKey)(value);

const receipt = (key: DeliveryKey): DeliveryReceipt => ({
  deliveryKey: key,
  operation: "sendMessage",
  target: {
    _tag: "Message",
    message: { conversation, messageId: "message-1" },
  },
});

const makeStore = makeBotCapabilityStore.pipe(Effect.provide(configLayer));

describe("BotCapabilityStore", () => {
  it.effect("encrypts Response References at rest and expires them", () =>
    Effect.gen(function* () {
      const storage = yield* Unstorage;
      const store = yield* makeStore;
      const now = yield* Clock.currentTimeMillis;
      const reference = yield* store.issueResponseReference({
        applicationId: "application-1",
        client,
        interactionToken: "provider-token-must-stay-secret",
        permittedOperations: ["respond"],
        expiresAt: now + 5_000,
      });

      const keys = yield* Effect.promise(() => storage.getKeys("capabilities:responses:"));
      expect(keys).toHaveLength(1);
      const stored = yield* Effect.promise(() => storage.getItem(keys[0]!));
      expect(JSON.stringify(stored)).not.toContain("provider-token-must-stay-secret");

      expect(yield* store.resolveResponseReference(reference)).toEqual({
        applicationId: "application-1",
        client,
        interactionToken: "provider-token-must-stay-secret",
        permittedOperations: ["respond"],
        expiresAt: now + 5_000,
      });

      yield* TestClock.adjust(Duration.seconds(5));
      const expired = yield* Effect.exit(store.resolveResponseReference(reference));
      expect(Exit.isFailure(expired)).toBe(true);
      if (Exit.isSuccess(expired)) return;
      expect(Cause.squash(expired.cause)).toMatchObject({ _tag: "BotResponseExpired" });
    }).pipe(Effect.provide(Unstorage.memoryLayer)),
  );

  it.effect("replays a completed receipt without repeating delivery", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const key = deliveryKey("delivery-replay");
      let deliveries = 0;
      const deliver = Effect.sync(() => {
        deliveries += 1;
        return receipt(key);
      });
      const input = {
        deliveryKey: key,
        operation: "sendMessage" as const,
        encodedInput: { conversation, content: "hello" },
        effect: deliver,
        isDefinitiveFailure: () => false,
      };

      const first = yield* store.executeDelivery(input);
      const replay = yield* store.executeDelivery(input);

      expect(replay).toEqual(first);
      expect(deliveries).toBe(1);
    }).pipe(Effect.provide(Unstorage.memoryLayer)),
  );

  it.effect("rejects Delivery Key collisions without invoking the provider", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const key = deliveryKey("delivery-collision");
      let deliveries = 0;
      const deliver = Effect.sync(() => {
        deliveries += 1;
        return receipt(key);
      });

      yield* store.executeDelivery({
        deliveryKey: key,
        operation: "sendMessage",
        encodedInput: { content: "first" },
        effect: deliver,
        isDefinitiveFailure: () => false,
      });
      const collision = yield* Effect.exit(
        store.executeDelivery({
          deliveryKey: key,
          operation: "sendMessage",
          encodedInput: { content: "different" },
          effect: deliver,
          isDefinitiveFailure: () => false,
        }),
      );

      expect(Exit.isFailure(collision)).toBe(true);
      if (Exit.isSuccess(collision)) return;
      expect(Cause.squash(collision.cause)).toBeInstanceOf(BotRequestRejected);
      expect(deliveries).toBe(1);
    }).pipe(Effect.provide(Unstorage.memoryLayer)),
  );

  it.effect("shares an atomic reservation across store instances", () =>
    Effect.gen(function* () {
      const firstStore = yield* makeStore;
      const secondStore = yield* makeStore;
      const key = deliveryKey("delivery-concurrent");
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      let deliveries = 0;
      const input = {
        deliveryKey: key,
        operation: "sendMessage" as const,
        encodedInput: { content: "concurrent" },
        effect: Effect.gen(function* () {
          deliveries += 1;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(finish);
          return receipt(key);
        }),
        isDefinitiveFailure: () => false,
      };

      const first = yield* Effect.forkChild(firstStore.executeDelivery(input));
      yield* Deferred.await(started);
      const concurrent = yield* Effect.exit(secondStore.executeDelivery(input));
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(first);

      expect(Exit.isFailure(concurrent)).toBe(true);
      if (Exit.isSuccess(concurrent)) return;
      expect(Cause.squash(concurrent.cause)).toBeInstanceOf(BotDependencyUnavailable);
      expect(deliveries).toBe(1);
    }).pipe(Effect.provide(Unstorage.memoryLayer)),
  );

  it.effect("releases a reservation after a definitive failure", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const key = deliveryKey("delivery-definitive-failure");
      let deliveries = 0;
      const failed = yield* Effect.exit(
        store.executeDelivery({
          deliveryKey: key,
          operation: "sendMessage",
          encodedInput: { content: "retryable" },
          effect: Effect.sync(() => {
            deliveries += 1;
          }).pipe(
            Effect.andThen(
              Effect.fail(new BotRequestRejected({ message: "definitive provider rejection" })),
            ),
          ),
          isDefinitiveFailure: () => true,
        }),
      );
      expect(Exit.isFailure(failed)).toBe(true);

      const retried = yield* store.executeDelivery({
        deliveryKey: key,
        operation: "sendMessage",
        encodedInput: { content: "retryable" },
        effect: Effect.sync(() => {
          deliveries += 1;
          return receipt(key);
        }),
        isDefinitiveFailure: () => false,
      });

      expect(retried).toEqual(receipt(key));
      expect(deliveries).toBe(2);
    }).pipe(Effect.provide(Unstorage.memoryLayer)),
  );

  it.effect("does not blindly retry an ambiguous delivery", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const key = deliveryKey("delivery-ambiguous");
      let deliveries = 0;

      const initialFailure = yield* Effect.exit(
        store.executeDelivery({
          deliveryKey: key,
          operation: "sendMessage",
          encodedInput: { content: "hello" },
          effect: Effect.sync(() => {
            deliveries += 1;
          }).pipe(Effect.andThen(Effect.fail("ambiguous provider failure"))),
          isDefinitiveFailure: () => false,
        }),
      );
      expect(Exit.isFailure(initialFailure)).toBe(true);
      const replay = yield* Effect.exit(
        store.executeDelivery({
          deliveryKey: key,
          operation: "sendMessage",
          encodedInput: { content: "hello" },
          effect: Effect.sync(() => {
            deliveries += 1;
            return receipt(key);
          }),
          isDefinitiveFailure: () => false,
        }),
      );

      expect(Exit.isFailure(replay)).toBe(true);
      if (Exit.isSuccess(replay)) return;
      expect(Cause.squash(replay.cause)).toBeInstanceOf(BotDependencyUnavailable);
      expect(deliveries).toBe(1);
    }).pipe(Effect.provide(Unstorage.memoryLayer)),
  );
});
