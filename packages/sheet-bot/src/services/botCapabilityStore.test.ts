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
  Metric,
  Predicate,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { Unstorage } from "dfx-discord-utils/discord/cache";
import {
  BotDependencyUnavailable,
  BotRequestRejected,
  DeliveryKey,
  SemanticFileIdentity,
  type DeliveryReceipt,
} from "sheet-bot-api";
import { makeBotCapabilityStore, unresolvedInspectionLimit } from "./botCapabilityStore";
import {
  sheetBotDeliveryAmbiguousOutcomes,
  sheetBotDeliveryObservabilitySaturated,
  sheetBotDeliveryOldestUnresolvedAgeSeconds,
  sheetBotDeliveryUnresolvedReservations,
} from "./botDeliveryMetrics";
import { deliveryStoreInput } from "./botDeliveryBinding";

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
const deliveryStoragePrefix = "capabilities:deliveries:";
const unresolvedDeliveryStoragePrefix = "capabilities:unresolved-deliveries:";

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
        workspaceId: "workspace-1",
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
        workspaceId: "workspace-1",
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

  it.effect("records a confirmed reconciliation and replays its receipt", () =>
    Effect.gen(function* () {
      const storage = yield* Unstorage;
      const store = yield* makeStore;
      const key = deliveryKey("delivery-confirmed-reconciliation");
      const storageKey = `${deliveryStoragePrefix}${key}`;
      let deliveries = 0;
      const encodedInput = { content: "confirmed" };

      const initialFailure = yield* Effect.exit(
        store.executeDelivery({
          deliveryKey: key,
          operation: "sendMessage",
          encodedInput,
          effect: Effect.sync(() => {
            deliveries += 1;
          }).pipe(Effect.andThen(Effect.fail("provider response was lost"))),
          isDefinitiveFailure: () => false,
        }),
      );
      expect(Exit.isFailure(initialFailure)).toBe(true);
      const ambiguousRecord = yield* Effect.promise(() =>
        storage.getItem<Record<string, unknown>>(storageKey),
      );
      expect(ambiguousRecord).not.toBeNull();
      if (Predicate.isNull(ambiguousRecord)) return;
      yield* Effect.promise(() =>
        storage.setItem(storageKey, { ...ambiguousRecord, futureRecordField: "preserved" }),
      );

      const confirmedReceipt = receipt(key);
      const reconciled = yield* store.reconcileDelivery({
        deliveryKey: key,
        actor: "on-call@example.com",
        evidence: "Discord message message-1 was inspected",
        resolution: { _tag: "Confirmed", receipt: confirmedReceipt },
      });
      expect(reconciled).toMatchObject({
        outcome: "confirmed",
        operation: "sendMessage",
        receipt: confirmedReceipt,
      });
      const stored = yield* Effect.promise(() =>
        storage.getItem<Record<string, unknown>>(storageKey),
      );
      expect(stored).toMatchObject({ futureRecordField: "preserved", state: "completed" });
      expect(stored).not.toHaveProperty("reservationId");
      expect(stored).not.toHaveProperty("reservedAt");
      expect(stored).not.toHaveProperty("ambiguityRecordedAt");
      const unresolvedMarkerKey = `${unresolvedDeliveryStoragePrefix}${key}`;
      yield* Effect.promise(() =>
        storage.setItem(unresolvedMarkerKey, { deliveryKey: key, operation: "sendMessage" }),
      );
      yield* store.reconcileDelivery({
        deliveryKey: key,
        actor: "on-call@example.com",
        evidence: "Discord message message-1 was inspected",
        resolution: { _tag: "Confirmed", receipt: confirmedReceipt },
      });
      expect(yield* Effect.promise(() => storage.getItem(unresolvedMarkerKey))).toBeNull();

      const replay = yield* store.executeDelivery({
        deliveryKey: key,
        operation: "sendMessage",
        encodedInput,
        effect: Effect.sync(() => {
          deliveries += 1;
          return confirmedReceipt;
        }),
        isDefinitiveFailure: () => false,
      });
      expect(replay).toEqual(confirmedReceipt);
      expect(deliveries).toBe(1);
    }).pipe(Effect.provide(Unstorage.memoryLayer)),
  );

  it.effect("marks an ambiguous reservation safe to retry before one bounded retry", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const key = deliveryKey("delivery-safe-retry-reconciliation");
      const encodedInput = { content: "safe retry" };
      let deliveries = 0;

      yield* Effect.exit(
        store.executeDelivery({
          deliveryKey: key,
          operation: "sendMessage",
          encodedInput,
          effect: Effect.sync(() => {
            deliveries += 1;
          }).pipe(Effect.andThen(Effect.fail("provider response was lost"))),
          isDefinitiveFailure: () => false,
        }),
      );

      const retryable = yield* store.reconcileDelivery({
        deliveryKey: key,
        actor: "on-call@example.com",
        evidence: "Discord audit log confirms no message was created",
        resolution: { _tag: "SafeRetry" },
      });
      expect(retryable).toMatchObject({ outcome: "safeRetry", operation: "sendMessage" });

      const retried = yield* store.executeDelivery({
        deliveryKey: key,
        operation: "sendMessage",
        encodedInput,
        effect: Effect.sync(() => {
          deliveries += 1;
          return receipt(key);
        }),
        isDefinitiveFailure: () => false,
      });
      expect(retried).toEqual(receipt(key));
      expect(deliveries).toBe(2);
      expect(yield* store.inspectDelivery(key)).toMatchObject({
        outcome: "confirmed",
        reconciliation: {
          actor: "on-call@example.com",
          evidence: "Discord audit log confirms no message was created",
        },
      });
    }).pipe(Effect.provide(Unstorage.memoryLayer)),
  );

  it.effect("accepts changed regenerated bytes after semantic-file safe retry", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const key = deliveryKey("delivery-semantic-file-safe-retry");
      const binding = {
        semanticIdentity: Schema.decodeUnknownSync(SemanticFileIdentity)("semantic-screenshot-1"),
        logicalRequest: '["workspace-1","alpha",2]',
      };
      const encodedInput = (content: Uint8Array) =>
        deliveryStoreInput({
          message: {
            files: [
              {
                name: "screenshot.png",
                contentType: "image/png",
                content,
                deliveryBinding: binding,
              },
            ],
          },
        });
      let deliveries = 0;

      yield* Effect.exit(
        store.executeDelivery({
          deliveryKey: key,
          operation: "sendMessage",
          encodedInput: encodedInput(new Uint8Array([1, 2, 3])),
          effect: Effect.sync(() => {
            deliveries += 1;
          }).pipe(Effect.andThen(Effect.fail("provider response was lost"))),
          isDefinitiveFailure: () => false,
        }),
      );
      yield* store.reconcileDelivery({
        deliveryKey: key,
        actor: "on-call@example.com",
        evidence: "Provider confirms no response update",
        resolution: { _tag: "SafeRetry" },
      });

      const retried = yield* store.executeDelivery({
        deliveryKey: key,
        operation: "sendMessage",
        encodedInput: encodedInput(new Uint8Array([9, 8, 7, 6])),
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

  it.effect("rejects a confirmed receipt bound to another Delivery Key", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const key = deliveryKey("delivery-confirmed-receipt-mismatch");

      yield* Effect.exit(
        store.executeDelivery({
          deliveryKey: key,
          operation: "sendMessage",
          encodedInput: { content: "mismatched receipt" },
          effect: Effect.fail("provider response was lost"),
          isDefinitiveFailure: () => false,
        }),
      );
      const exit = yield* Effect.exit(
        store.reconcileDelivery({
          deliveryKey: key,
          actor: "on-call@example.com",
          evidence: "Discord message was inspected",
          resolution: {
            _tag: "Confirmed",
            receipt: receipt(deliveryKey("another-delivery-key")),
          },
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) return;
      expect(Cause.squash(exit.cause)).toBeInstanceOf(BotRequestRejected);
    }).pipe(Effect.provide(Unstorage.memoryLayer)),
  );

  it.effect("keeps an interrupted attempt unresolved until the pending safety window elapses", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const key = deliveryKey("delivery-interrupted-reconciliation");
      const started = yield* Deferred.make<void>();
      const attempt = yield* Effect.forkChild(
        store.executeDelivery({
          deliveryKey: key,
          operation: "sendMessage",
          encodedInput: { content: "interrupted" },
          effect: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          isDefinitiveFailure: () => false,
        }),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(attempt);

      expect(yield* store.inspectDelivery(key)).toMatchObject({
        outcome: "unresolved",
        reservationState: "pending",
      });
      const tooRecent = yield* Effect.exit(
        store.reconcileDelivery({
          deliveryKey: key,
          actor: "on-call@example.com",
          evidence: "The interrupted pod is no longer running",
          resolution: { _tag: "SafeRetry" },
        }),
      );
      expect(Exit.isFailure(tooRecent)).toBe(true);
      if (Exit.isSuccess(tooRecent)) return;
      expect(Cause.squash(tooRecent.cause)).toBeInstanceOf(BotRequestRejected);

      // The 15-minute minimum is inclusive: exactly the boundary is safe to reconcile.
      yield* TestClock.adjust(Duration.minutes(15));
      expect(
        yield* store.reconcileDelivery({
          deliveryKey: key,
          actor: "on-call@example.com",
          evidence: "The interrupted pod is gone and Discord has no matching effect",
          resolution: { _tag: "SafeRetry" },
        }),
      ).toMatchObject({ outcome: "safeRetry" });
    }).pipe(Effect.provide(Unstorage.memoryLayer)),
  );

  it.effect("allows an evidence-backed safe retry for a legacy pending reservation", () =>
    Effect.gen(function* () {
      const storage = yield* Unstorage;
      const store = yield* makeStore;
      const key = deliveryKey("delivery-legacy-pending-reconciliation");
      yield* Effect.promise(() =>
        storage.setItem(`${deliveryStoragePrefix}${key}`, {
          state: "pending",
          operation: "sendMessage",
          inputHash: "legacy-input-hash",
        }),
      );

      expect(
        yield* store.reconcileDelivery({
          deliveryKey: key,
          actor: "on-call@example.com",
          evidence: "All pre-upgrade sheet-bot pods are terminated and Discord has no effect",
          resolution: { _tag: "SafeRetry" },
        }),
      ).toMatchObject({ outcome: "safeRetry", operation: "sendMessage" });
    }).pipe(Effect.provide(Unstorage.memoryLayer)),
  );

  it.effect("leaves an unresolved reservation in place without repeating delivery", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const key = deliveryKey("delivery-unresolved-reconciliation");
      const encodedInput = { content: "unresolved" };
      let deliveries = 0;

      yield* Effect.exit(
        store.executeDelivery({
          deliveryKey: key,
          operation: "sendMessage",
          encodedInput,
          effect: Effect.sync(() => {
            deliveries += 1;
          }).pipe(Effect.andThen(Effect.fail("provider response was lost"))),
          isDefinitiveFailure: () => false,
        }),
      );

      const unresolved = yield* store.reconcileDelivery({
        deliveryKey: key,
        actor: "on-call@example.com",
        evidence: "Provider evidence remains inconclusive",
        resolution: { _tag: "Unresolved" },
      });
      expect(unresolved).toMatchObject({
        outcome: "unresolved",
        reservationState: "ambiguous",
        reconciliation: {
          actor: "on-call@example.com",
          evidence: "Provider evidence remains inconclusive",
        },
      });

      expect(yield* store.inspectDelivery(key)).toMatchObject({
        outcome: "unresolved",
        reconciliation: {
          actor: "on-call@example.com",
          evidence: "Provider evidence remains inconclusive",
        },
      });

      const replay = yield* Effect.exit(
        store.executeDelivery({
          deliveryKey: key,
          operation: "sendMessage",
          encodedInput,
          effect: Effect.sync(() => {
            deliveries += 1;
            return receipt(key);
          }),
          isDefinitiveFailure: () => false,
        }),
      );
      expect(Exit.isFailure(replay)).toBe(true);
      expect(deliveries).toBe(1);
      expect(yield* store.inspectDelivery(key)).toMatchObject({
        outcome: "unresolved",
        reservationState: "ambiguous",
      });
    }).pipe(Effect.provide(Unstorage.memoryLayer)),
  );

  it.effect("backfills the unresolved index for legacy delivery records", () =>
    Effect.gen(function* () {
      const storage = yield* Unstorage;
      const store = yield* makeStore;
      const pendingKey = deliveryKey("delivery-backfill-pending");
      const ambiguousKey = deliveryKey("delivery-backfill-ambiguous");
      const invalidKey = deliveryKey("delivery-backfill-invalid");
      yield* Effect.promise(() =>
        storage.setItem(`${deliveryStoragePrefix}${pendingKey}`, {
          state: "pending",
          operation: "sendMessage",
          inputHash: "pending-input-hash",
        }),
      );
      yield* Effect.promise(() =>
        storage.setItem(`${deliveryStoragePrefix}${ambiguousKey}`, {
          state: "ambiguous",
          operation: "sendMessage",
          inputHash: "ambiguous-input-hash",
          ambiguityRecordedAt: 0,
        }),
      );
      yield* Effect.promise(() =>
        storage.setItem(`${deliveryStoragePrefix}${invalidKey}`, { state: "invalid" }),
      );

      yield* store.backfillDeliveryReservationIndex;
      expect(
        yield* Effect.promise(() => storage.getKeys(unresolvedDeliveryStoragePrefix)),
      ).toHaveLength(2);

      yield* Effect.promise(() =>
        storage.setItem(`${unresolvedDeliveryStoragePrefix}${invalidKey}`, {
          deliveryKey: invalidKey,
          operation: "sendMessage",
        }),
      );
      yield* store.refreshDeliveryReservationMetrics;
      expect((yield* Metric.value(sheetBotDeliveryUnresolvedReservations)).value).toBe(2);
      expect((yield* Metric.value(sheetBotDeliveryOldestUnresolvedAgeSeconds)).value).toBe(
        2_592_000,
      );
    }).pipe(Effect.provide(Unstorage.memoryLayer)),
  );

  it.effect("publishes bounded unresolved reservation metrics", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const key = deliveryKey("delivery-observability");

      yield* Effect.exit(
        store.executeDelivery({
          deliveryKey: key,
          operation: "sendMessage",
          encodedInput: { content: "metrics" },
          effect: Effect.fail("provider response was lost"),
          isDefinitiveFailure: () => false,
        }),
      );
      yield* TestClock.adjust(Duration.seconds(10));
      yield* store.refreshDeliveryReservationMetrics;

      expect((yield* Metric.value(sheetBotDeliveryUnresolvedReservations)).value).toBe(1);
      expect((yield* Metric.value(sheetBotDeliveryOldestUnresolvedAgeSeconds)).value).toBe(10);
      expect((yield* Metric.value(sheetBotDeliveryObservabilitySaturated)).value).toBe(0);

      yield* store.reconcileDelivery({
        deliveryKey: key,
        actor: "on-call@example.com",
        evidence: "Provider evidence confirms no write",
        resolution: { _tag: "SafeRetry" },
      });
      yield* store.refreshDeliveryReservationMetrics;
      expect((yield* Metric.value(sheetBotDeliveryUnresolvedReservations)).value).toBe(0);
    }).pipe(Effect.provide(Unstorage.memoryLayer)),
  );

  it.effect("reports saturation when unresolved reservations exceed the inspection limit", () =>
    Effect.gen(function* () {
      const storage = yield* Unstorage;
      const store = yield* makeStore;

      yield* Effect.forEach(
        Array.from({ length: unresolvedInspectionLimit + 1 }, (_, index) => index),
        (index) => {
          const key = deliveryKey(`delivery-saturation-${index}`);
          return Effect.all([
            Effect.promise(() =>
              storage.setItem(`${deliveryStoragePrefix}${key}`, {
                state: "pending",
                operation: "sendMessage",
                inputHash: `input-${index}`,
                reservedAt: 0,
              }),
            ),
            Effect.promise(() =>
              storage.setItem(`${unresolvedDeliveryStoragePrefix}${key}`, {
                deliveryKey: key,
                operation: "sendMessage",
              }),
            ),
          ]);
        },
        { concurrency: 32, discard: true },
      );

      yield* store.refreshDeliveryReservationMetrics;
      yield* store.refreshDeliveryReservationMetrics;
      expect((yield* Metric.value(sheetBotDeliveryUnresolvedReservations)).value).toBe(
        unresolvedInspectionLimit + 1,
      );
      expect((yield* Metric.value(sheetBotDeliveryObservabilitySaturated)).value).toBe(1);

      yield* store.refreshDeliveryReservationMetrics;
      expect((yield* Metric.value(sheetBotDeliveryUnresolvedReservations)).value).toBe(
        unresolvedInspectionLimit + 1,
      );
      expect((yield* Metric.value(sheetBotDeliveryObservabilitySaturated)).value).toBe(1);
    }).pipe(Effect.provide(Unstorage.memoryLayer)),
  );

  it.effect("does not infer saturation from a nonzero storage cursor", () =>
    Effect.gen(function* () {
      const storage = yield* Unstorage;
      const keys = [deliveryKey("delivery-cursor-first"), deliveryKey("delivery-cursor-second")];
      yield* Effect.forEach(
        keys,
        (key) =>
          Effect.all([
            Effect.promise(() =>
              storage.setItem(`${deliveryStoragePrefix}${key}`, {
                state: "pending",
                operation: "sendMessage",
                inputHash: `input-${key}`,
                reservedAt: 0,
              }),
            ),
            Effect.promise(() =>
              storage.setItem(`${unresolvedDeliveryStoragePrefix}${key}`, {
                deliveryKey: key,
                operation: "sendMessage",
              }),
            ),
          ]),
        { discard: true },
      );
      const pages = [
        { cursor: "next", keys: [`${unresolvedDeliveryStoragePrefix}${keys[0]}`] },
        { cursor: "0", keys: [`${unresolvedDeliveryStoragePrefix}${keys[1]}`] },
      ] as const;
      let pageIndex = 0;
      const store = yield* makeStore.pipe(
        Effect.provide(
          Unstorage.layer({
            ...storage,
            scanKeys: () => Promise.resolve(pages[pageIndex++] ?? { cursor: "0", keys: [] }),
          }),
        ),
      );

      yield* store.refreshDeliveryReservationMetrics;
      yield* store.refreshDeliveryReservationMetrics;

      expect((yield* Metric.value(sheetBotDeliveryUnresolvedReservations)).value).toBe(2);
      expect((yield* Metric.value(sheetBotDeliveryObservabilitySaturated)).value).toBe(0);
    }).pipe(Effect.provide(Unstorage.memoryLayer)),
  );

  it.effect("records ambiguity when a failed transition leaves the reservation pending", () =>
    Effect.gen(function* () {
      const storage = yield* Unstorage;
      const store = yield* makeStore.pipe(
        Effect.provide(
          Unstorage.layer({
            ...storage,
            compareAndSetItem: () => Promise.resolve(false),
          }),
        ),
      );
      const key = deliveryKey("delivery-ambiguous-transition-race");
      const ambiguousOutcomes = Metric.withAttributes(sheetBotDeliveryAmbiguousOutcomes, {
        operation: "sendMessage",
      });
      const before = yield* Metric.value(ambiguousOutcomes);

      const exit = yield* Effect.exit(
        store.executeDelivery({
          deliveryKey: key,
          operation: "sendMessage",
          encodedInput: { content: "ambiguous race" },
          effect: Effect.fail("provider response was lost"),
          isDefinitiveFailure: () => false,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* store.inspectDelivery(key)).toMatchObject({
        outcome: "unresolved",
        reservationState: "pending",
      });
      expect((yield* Metric.value(ambiguousOutcomes)).count - before.count).toBe(1);
    }).pipe(Effect.provide(Unstorage.memoryLayer)),
  );
});
