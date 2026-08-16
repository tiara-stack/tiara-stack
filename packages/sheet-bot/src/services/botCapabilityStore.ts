import {
  Clock,
  Context,
  Effect,
  Layer,
  Match,
  Metric,
  Option,
  Predicate,
  Redacted,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import { Unstorage } from "dfx-discord-utils/discord/cache";
import {
  BotDependencyUnavailable,
  BotDeliveryOperation,
  BotRequestRejected,
  BotResponseExpired,
  ClientRef,
  DeliveryKey,
  DeliveryReceipt,
  ResponseReference,
  type ClientRef as ClientRefType,
  type DeliveryReceipt as DeliveryReceiptType,
  type ResponseReference as ResponseReferenceType,
} from "sheet-bot-api";
import { config } from "@/config";
import {
  sheetBotDeliveryAmbiguousOutcomes,
  sheetBotDeliveryObservabilitySaturated,
  sheetBotDeliveryOldestUnresolvedAgeSeconds,
  sheetBotDeliveryReconciliations,
  sheetBotDeliveryUnresolvedReservations,
} from "./botDeliveryMetrics";

const responseRecordSchema = Schema.Struct({
  applicationId: Schema.String,
  client: ClientRef,
  interactionToken: Schema.String,
  permittedOperations: Schema.Array(Schema.Literal("respond")),
  expiresAt: Schema.Number,
  workspaceId: Schema.optional(Schema.String),
});

const encryptedResponseRecordSchema = Schema.Struct({
  iv: Schema.String,
  ciphertext: Schema.String,
});

// Raw actor and evidence are retained for 30-day operator audit attribution. Structured logs
// use their hashes so these operator-supplied values do not enter the logging pipeline.
const reconciliationSchema = Schema.Struct({
  actor: Schema.NonEmptyString,
  evidence: Schema.NonEmptyString,
  reconciledAt: Schema.Number,
});

const pendingDeliveryRecordSchema = Schema.Struct({
  state: Schema.Literal("pending"),
  operation: BotDeliveryOperation,
  inputHash: Schema.String,
  reservationId: Schema.optional(Schema.String),
  reservedAt: Schema.optional(Schema.Number),
  reconciliation: Schema.optional(reconciliationSchema),
});

const ambiguousDeliveryRecordSchema = Schema.Struct({
  state: Schema.Literal("ambiguous"),
  operation: BotDeliveryOperation,
  inputHash: Schema.String,
  reservationId: Schema.optional(Schema.String),
  reservedAt: Schema.optional(Schema.Number),
  ambiguityRecordedAt: Schema.Number,
  reconciliation: Schema.optional(reconciliationSchema),
});

const retryableDeliveryRecordSchema = Schema.Struct({
  state: Schema.Literal("retryable"),
  operation: BotDeliveryOperation,
  inputHash: Schema.String,
  reconciliation: reconciliationSchema,
});

const completedDeliveryRecordSchema = Schema.Struct({
  state: Schema.Literal("completed"),
  operation: BotDeliveryOperation,
  inputHash: Schema.String,
  receipt: DeliveryReceipt,
  reconciliation: Schema.optional(reconciliationSchema),
});

const deliveryRecordSchema = Schema.Union([
  pendingDeliveryRecordSchema,
  ambiguousDeliveryRecordSchema,
  retryableDeliveryRecordSchema,
  completedDeliveryRecordSchema,
]);

const deliveryRecordFieldNames: ReadonlySet<string> = new Set([
  ...Object.keys(pendingDeliveryRecordSchema.fields),
  ...Object.keys(ambiguousDeliveryRecordSchema.fields),
  ...Object.keys(retryableDeliveryRecordSchema.fields),
  ...Object.keys(completedDeliveryRecordSchema.fields),
]);

type ResponseRecord = typeof responseRecordSchema.Type;
type DeliveryRecord = typeof deliveryRecordSchema.Type;

const responsePrefix = "capabilities:responses:";
const deliveryPrefix = "capabilities:deliveries:";
const unresolvedDeliveryPrefix = "capabilities:unresolved-deliveries:";
const deliveryRetentionSeconds = 60 * 60 * 24 * 30;
export const unresolvedInspectionLimit = 1_000;
const pendingSafeRetryMinimumAgeMs = 15 * 60 * 1_000;
// Legacy reservations have no timestamp. Model them at the full retention horizon so
// unresolved-age alerts fire without coupling this policy to the safe-retry window.
const legacyUnresolvedAgeSeconds = deliveryRetentionSeconds;
const observabilityRefreshInterval = "30 seconds";
const deliveryTransitionAttempts = 3;
const deliveryTransitionRetryDelay = "10 millis";
const deliveryBackfillPageDelay = "10 millis";

const effectiveReservationAgeMs = (reservedAt: number | undefined, now: number) =>
  Predicate.isUndefined(reservedAt)
    ? legacyUnresolvedAgeSeconds * 1_000
    : Math.max(0, now - reservedAt);

const unavailable = (message: string) => new BotDependencyUnavailable({ message });

const storageGet = <A>(storage: typeof Unstorage.Service, key: string) =>
  Effect.tryPromise({
    try: () => storage.getItem<A>(key),
    catch: () => unavailable("Bot capability storage read failed"),
  });

const storageSet = (storage: typeof Unstorage.Service, key: string, value: object, ttl: number) =>
  Effect.tryPromise({
    try: () => storage.setItem(key, value, { ttl }),
    catch: () => unavailable("Bot capability storage write failed"),
  });

const storageSetIfAbsent = (
  storage: typeof Unstorage.Service,
  key: string,
  value: object,
  ttl: number,
) =>
  Effect.tryPromise({
    try: () => storage.setItemIfAbsent(key, value, { ttl }),
    catch: () => unavailable("Bot capability storage reservation failed"),
  });

const storageRemove = (storage: typeof Unstorage.Service, key: string) =>
  Effect.tryPromise({
    try: () => storage.removeItem(key),
    catch: () => unavailable("Bot capability storage cleanup failed"),
  });

const storageCompareAndSet = (
  storage: typeof Unstorage.Service,
  key: string,
  expected: object,
  value: object,
  ttl: number,
) =>
  Effect.tryPromise({
    try: () => storage.compareAndSetItem(key, expected, value, { ttl }),
    catch: () => unavailable("Bot capability storage transition failed"),
  });

const storageCompareAndRemove = (
  storage: typeof Unstorage.Service,
  key: string,
  expected: object,
) =>
  Effect.tryPromise({
    try: () => storage.compareAndRemoveItem(key, expected),
    catch: () => unavailable("Bot capability storage transition failed"),
  });

const storageScanKeys = (
  storage: typeof Unstorage.Service,
  prefix: string,
  cursor: string,
  limit: number,
) =>
  Effect.tryPromise({
    try: () => storage.scanKeys(prefix, cursor, limit),
    catch: () => unavailable("Bot capability storage inspection failed"),
  });

const decodeStored = <A>(schema: Schema.Codec<A>, value: unknown, description: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => unavailable(`Stored ${description} is invalid`)),
  );

const canonicalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (Predicate.isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeJson(value[key])]),
    );
  }
  return value;
};

const stableJson = (value: unknown): string =>
  JSON.stringify(canonicalizeJson(value)) ?? "undefined";

const preserveStoredFields = <A extends DeliveryRecord>(raw: object, next: A): A =>
  Object.assign(
    {},
    Object.fromEntries(
      Object.entries(raw).filter(([field]) => !deliveryRecordFieldNames.has(field)),
    ),
    next,
  );

const bytesToBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const base64ToBytes = (value: string) => new Uint8Array(Buffer.from(value, "base64url"));

const sha256 = (value: string) =>
  Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    catch: () => unavailable("Delivery input hashing failed"),
  }).pipe(Effect.map((digest) => bytesToBase64(new Uint8Array(digest))));

const makeCipher = (secret: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const encoder = new TextEncoder();
    const keyMaterial = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey("raw", encoder.encode(Redacted.value(secret)), "HKDF", false, [
          "deriveKey",
        ]),
      catch: () => unavailable("Response Reference key import failed"),
    });
    const key = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: encoder.encode("sheet-bot-response-reference:salt:v1"),
            info: encoder.encode("sheet-bot-response-reference:aes-gcm:v1"),
          },
          keyMaterial,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      catch: () => unavailable("Response Reference key derivation failed"),
    });

    return {
      encrypt: (reference: ResponseReferenceType, record: ResponseRecord) =>
        Effect.gen(function* () {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const plaintext = new TextEncoder().encode(JSON.stringify(record));
          const additionalData = new TextEncoder().encode(reference);
          const ciphertext = yield* Effect.tryPromise({
            try: () =>
              crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, plaintext),
            catch: () => unavailable("Response Reference encryption failed"),
          });
          return {
            iv: bytesToBase64(iv),
            ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
          };
        }),
      decrypt: (
        reference: ResponseReferenceType,
        encrypted: typeof encryptedResponseRecordSchema.Type,
      ) =>
        Effect.tryPromise({
          try: async () => {
            const additionalData = new TextEncoder().encode(reference);
            const plaintext = await crypto.subtle.decrypt(
              { name: "AES-GCM", iv: base64ToBytes(encrypted.iv), additionalData },
              key,
              base64ToBytes(encrypted.ciphertext),
            );
            return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
          },
          catch: () => unavailable("Stored Response Reference cannot be decrypted"),
        }).pipe(
          Effect.flatMap((record) =>
            decodeStored(responseRecordSchema, record, "Response Reference"),
          ),
        ),
    };
  });

interface IssueResponseReferenceInput {
  readonly applicationId: string;
  readonly client: ClientRefType;
  readonly interactionToken: string;
  readonly permittedOperations: ReadonlyArray<"respond">;
  readonly expiresAt: number;
  readonly workspaceId?: string | undefined;
}

type DeliveryReconciliationInspection =
  | {
      readonly outcome: "notFound";
      readonly deliveryKey: DeliveryKey;
    }
  | {
      readonly outcome: "unresolved";
      readonly deliveryKey: DeliveryKey;
      readonly operation: BotDeliveryOperation;
      readonly reservationState: "pending" | "ambiguous";
      readonly reservedAt?: number | undefined;
      readonly ageMs?: number | undefined;
      readonly reconciliation?: typeof reconciliationSchema.Type | undefined;
    }
  | {
      readonly outcome: "safeRetry";
      readonly deliveryKey: DeliveryKey;
      readonly operation: BotDeliveryOperation;
      readonly reconciliation: typeof reconciliationSchema.Type;
    }
  | {
      readonly outcome: "confirmed";
      readonly deliveryKey: DeliveryKey;
      readonly operation: BotDeliveryOperation;
      readonly receipt: DeliveryReceiptType;
      readonly reconciliation?: typeof reconciliationSchema.Type | undefined;
    };

type DeliveryReconciliationResolution =
  | { readonly _tag: "Confirmed"; readonly receipt: DeliveryReceiptType }
  | { readonly _tag: "SafeRetry" }
  | { readonly _tag: "Unresolved" };

interface ReconcileDeliveryInput {
  readonly deliveryKey: DeliveryKey;
  readonly actor: string;
  readonly evidence: string;
  readonly resolution: DeliveryReconciliationResolution;
}

interface BotCapabilityStoreShape {
  readonly issueResponseReference: (
    input: IssueResponseReferenceInput,
  ) => Effect.Effect<ResponseReferenceType, BotDependencyUnavailable | BotResponseExpired>;
  readonly resolveResponseReference: (
    reference: ResponseReferenceType,
  ) => Effect.Effect<ResponseRecord, BotDependencyUnavailable | BotResponseExpired>;
  readonly executeDelivery: <A extends DeliveryReceiptType, E, R>(input: {
    readonly deliveryKey: DeliveryKey;
    readonly operation: BotDeliveryOperation;
    readonly encodedInput: unknown;
    readonly effect: Effect.Effect<A, E, R>;
    readonly isDefinitiveFailure: (error: E) => boolean;
  }) => Effect.Effect<A, E | BotDependencyUnavailable | BotRequestRejected, R>;
  readonly inspectDelivery: (
    deliveryKey: DeliveryKey,
  ) => Effect.Effect<DeliveryReconciliationInspection, BotDependencyUnavailable>;
  readonly reconcileDelivery: (
    input: ReconcileDeliveryInput,
  ) => Effect.Effect<
    DeliveryReconciliationInspection,
    BotDependencyUnavailable | BotRequestRejected
  >;
  readonly backfillDeliveryReservationIndex: Effect.Effect<void, BotDependencyUnavailable>;
  readonly refreshDeliveryReservationMetrics: Effect.Effect<void, BotDependencyUnavailable>;
}

export const makeBotCapabilityStore = Effect.gen(function* () {
  const storage = yield* Unstorage;
  const encryptionSecret = yield* config.sheetBotCapabilityEncryptionSecret;
  const cipher = yield* makeCipher(encryptionSecret);

  const issueResponseReference = Effect.fn("BotCapabilityStore.issueResponseReference")(function* (
    input: IssueResponseReferenceInput,
  ) {
    const now = yield* Clock.currentTimeMillis;
    if (input.expiresAt <= now) {
      return yield* new BotResponseExpired({
        message: "Cannot issue an already-expired Response Reference",
      });
    }
    const reference = Schema.decodeUnknownSync(ResponseReference)(crypto.randomUUID());
    const encrypted = yield* cipher.encrypt(reference, input);
    yield* storageSet(
      storage,
      `${responsePrefix}${reference}`,
      encrypted,
      Math.max(1, Math.ceil((input.expiresAt - now) / 1000)),
    );
    return reference;
  });

  const resolveResponseReference = Effect.fn("BotCapabilityStore.resolveResponseReference")(
    function* (reference: ResponseReferenceType) {
      const stored = yield* storageGet(storage, `${responsePrefix}${reference}`);
      if (Predicate.isNull(stored)) {
        return yield* new BotResponseExpired({ message: "Response Reference has expired" });
      }
      const encrypted = yield* decodeStored(
        encryptedResponseRecordSchema,
        stored,
        "encrypted Response Reference",
      );
      const record = yield* cipher.decrypt(reference, encrypted);
      const now = yield* Clock.currentTimeMillis;
      if (record.expiresAt <= now) {
        yield* storageRemove(storage, `${responsePrefix}${reference}`).pipe(Effect.ignore);
        return yield* new BotResponseExpired({ message: "Response Reference has expired" });
      }
      return record;
    },
  );

  const deliveryStorageKey = (deliveryKey: DeliveryKey) => `${deliveryPrefix}${deliveryKey}`;
  const unresolvedStorageKey = (deliveryKey: DeliveryKey) =>
    `${unresolvedDeliveryPrefix}${deliveryKey}`;

  const readDeliveryRecord = Effect.fn("BotCapabilityStore.readDeliveryRecord")(function* (
    deliveryKey: DeliveryKey,
  ) {
    const stored = yield* storageGet(storage, deliveryStorageKey(deliveryKey));
    if (Predicate.isNull(stored)) return null;
    if (!Predicate.isObject(stored)) {
      return yield* unavailable("Stored Delivery Key is invalid");
    }
    const record = yield* Schema.decodeUnknownEffect(deliveryRecordSchema)(stored).pipe(
      Effect.mapError(() => unavailable("Stored Delivery Key is invalid")),
    );
    return { raw: stored, record };
  });

  const markUnresolved = (deliveryKey: DeliveryKey, operation: BotDeliveryOperation) =>
    storageSet(
      storage,
      unresolvedStorageKey(deliveryKey),
      { deliveryKey, operation },
      deliveryRetentionSeconds,
    );

  const clearUnresolved = (deliveryKey: DeliveryKey) =>
    storageRemove(storage, unresolvedStorageKey(deliveryKey)).pipe(Effect.ignore);

  const inspectionFromRecord = (
    deliveryKey: DeliveryKey,
    record: DeliveryRecord | null,
    now: number,
  ): DeliveryReconciliationInspection => {
    if (Predicate.isNull(record)) return { outcome: "notFound", deliveryKey };
    return Match.value(record).pipe(
      Match.when({ state: "pending" }, (pending) => ({
        outcome: "unresolved" as const,
        deliveryKey,
        operation: pending.operation,
        reservationState: "pending" as const,
        ...(pending.reservedAt === undefined
          ? {}
          : { reservedAt: pending.reservedAt, ageMs: Math.max(0, now - pending.reservedAt) }),
        ...(pending.reconciliation === undefined ? {} : { reconciliation: pending.reconciliation }),
      })),
      Match.when({ state: "ambiguous" }, (ambiguous) => ({
        outcome: "unresolved" as const,
        deliveryKey,
        operation: ambiguous.operation,
        reservationState: "ambiguous" as const,
        ...(ambiguous.reservedAt === undefined
          ? {}
          : { reservedAt: ambiguous.reservedAt, ageMs: Math.max(0, now - ambiguous.reservedAt) }),
        ...(ambiguous.reconciliation === undefined
          ? {}
          : { reconciliation: ambiguous.reconciliation }),
      })),
      Match.when({ state: "retryable" }, (retryable) => ({
        outcome: "safeRetry" as const,
        deliveryKey,
        operation: retryable.operation,
        reconciliation: retryable.reconciliation,
      })),
      Match.when({ state: "completed" }, (completed) => ({
        outcome: "confirmed" as const,
        deliveryKey,
        operation: completed.operation,
        receipt: completed.receipt,
        ...(completed.reconciliation === undefined
          ? {}
          : { reconciliation: completed.reconciliation }),
      })),
      Match.exhaustive,
    );
  };

  const inspectDelivery = Effect.fn("BotCapabilityStore.inspectDelivery")(function* (
    deliveryKey: DeliveryKey,
  ) {
    const entry = yield* readDeliveryRecord(deliveryKey);
    const now = yield* Clock.currentTimeMillis;
    return inspectionFromRecord(deliveryKey, entry?.record ?? null, now);
  });

  const recordReconciliationMetric = (resolution: string, result: string) =>
    Metric.update(
      Metric.withAttributes(sheetBotDeliveryReconciliations, { resolution, result }),
      1,
    );

  // This atomic state-transition loop keeps validation, CAS retries, metrics, and audit writes
  // together so each operator outcome has one reviewable safety boundary.
  // fallow-ignore-next-line complexity
  const reconcileDelivery = Effect.fn("BotCapabilityStore.reconcileDelivery")(function* (
    input: ReconcileDeliveryInput,
  ) {
    const actor = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(input.actor).pipe(
      Effect.mapError(
        () => new BotRequestRejected({ message: "Reconciliation actor is required" }),
      ),
    );
    const evidence = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(input.evidence).pipe(
      Effect.mapError(
        () => new BotRequestRejected({ message: "Reconciliation evidence is required" }),
      ),
    );
    const [actorHash, evidenceHash] = yield* Effect.all([sha256(actor), sha256(evidence)]);

    for (let attempt = 0; attempt < deliveryTransitionAttempts; attempt += 1) {
      if (attempt > 0) yield* Effect.sleep(deliveryTransitionRetryDelay);
      const now = yield* Clock.currentTimeMillis;
      const entry = yield* readDeliveryRecord(input.deliveryKey);
      if (Predicate.isNull(entry)) {
        yield* recordReconciliationMetric(input.resolution._tag, "not_found");
        return yield* new BotRequestRejected({ message: "Delivery Key reservation was not found" });
      }
      const { record } = entry;

      if (record.state === "completed") {
        yield* clearUnresolved(input.deliveryKey);
        if (
          input.resolution._tag === "Confirmed" &&
          stableJson(record.receipt) === stableJson(input.resolution.receipt)
        ) {
          yield* recordReconciliationMetric("Confirmed", "already_confirmed");
          return inspectionFromRecord(input.deliveryKey, record, now);
        }
        yield* recordReconciliationMetric(input.resolution._tag, "conflict");
        return yield* new BotRequestRejected({
          message: "Completed Delivery Key cannot be reconciled to a different outcome",
        });
      }

      if (record.state === "retryable") {
        yield* clearUnresolved(input.deliveryKey);
        if (input.resolution._tag === "SafeRetry") {
          yield* recordReconciliationMetric("SafeRetry", "already_retryable");
          return inspectionFromRecord(input.deliveryKey, record, now);
        }
        yield* recordReconciliationMetric(input.resolution._tag, "conflict");
        return yield* new BotRequestRejected({
          message: "Retryable Delivery Key cannot be reconciled to a different outcome",
        });
      }

      const reconciliation = { actor, evidence, reconciledAt: now };
      if (input.resolution._tag === "Unresolved") {
        const next = preserveStoredFields(entry.raw, { ...record, reconciliation });
        yield* markUnresolved(input.deliveryKey, record.operation);
        const transitioned = yield* storageCompareAndSet(
          storage,
          deliveryStorageKey(input.deliveryKey),
          entry.raw,
          next,
          deliveryRetentionSeconds,
        );
        if (!transitioned) continue;

        const inspection = inspectionFromRecord(input.deliveryKey, next, now);
        yield* recordReconciliationMetric("Unresolved", "applied");
        yield* Effect.logWarning("Sheet bot Delivery Key remains unresolved").pipe(
          Effect.annotateLogs({
            actorHash,
            deliveryKey: input.deliveryKey,
            evidenceHash,
            operation: record.operation,
            outcome: inspection.outcome,
          }),
        );
        return inspection;
      }

      let next: DeliveryRecord;
      if (input.resolution._tag === "Confirmed") {
        if (
          input.resolution.receipt.deliveryKey !== input.deliveryKey ||
          input.resolution.receipt.operation !== record.operation
        ) {
          yield* recordReconciliationMetric("Confirmed", "invalid_receipt");
          return yield* new BotRequestRejected({
            message:
              "Confirmed Delivery Receipt does not match the reserved Delivery Key operation",
          });
        }
        next = preserveStoredFields(entry.raw, {
          state: "completed",
          operation: record.operation,
          inputHash: record.inputHash,
          receipt: input.resolution.receipt,
          reconciliation,
        });
      } else {
        if (
          record.state === "pending" &&
          effectiveReservationAgeMs(record.reservedAt, now) < pendingSafeRetryMinimumAgeMs
        ) {
          yield* recordReconciliationMetric("SafeRetry", "reservation_too_recent");
          return yield* new BotRequestRejected({
            message:
              "Pending Delivery Key is too recent for safe retry; leave it unresolved until the original attempt cannot still be in flight",
          });
        }
        next = preserveStoredFields(entry.raw, {
          state: "retryable",
          operation: record.operation,
          inputHash: record.inputHash,
          reconciliation,
        });
      }

      const transitioned = yield* storageCompareAndSet(
        storage,
        deliveryStorageKey(input.deliveryKey),
        entry.raw,
        next,
        deliveryRetentionSeconds,
      );
      if (!transitioned) continue;

      yield* clearUnresolved(input.deliveryKey);
      yield* recordReconciliationMetric(input.resolution._tag, "applied");
      yield* Effect.logInfo("Reconciled sheet bot Delivery Key").pipe(
        Effect.annotateLogs({
          actorHash,
          deliveryKey: input.deliveryKey,
          evidenceHash,
          operation: record.operation,
          resolution: input.resolution._tag,
        }),
      );
      return inspectionFromRecord(input.deliveryKey, next, now);
    }

    yield* recordReconciliationMetric(input.resolution._tag, "concurrent_change");
    return yield* new BotDependencyUnavailable({
      message: "Delivery Key changed concurrently; inspect it again before reconciling",
    });
  });

  const backfillDeliveryReservationIndex = Effect.gen(function* () {
    let cursor = "0";
    let pageCount = 0;
    const visitedCursors = new Set<string>();
    // This runs in the scoped background fiber and intentionally remains exhaustive: a page cap
    // would permanently strand legacy reservations outside the unresolved index.
    do {
      if (visitedCursors.has(cursor)) {
        yield* Effect.logWarning(
          "Stopped the delivery reservation index backfill after its storage cursor repeated",
        ).pipe(Effect.annotateLogs({ cursor, pageCount }));
        return;
      }
      visitedCursors.add(cursor);
      const page = yield* storageScanKeys(
        storage,
        deliveryPrefix,
        cursor,
        unresolvedInspectionLimit,
      );
      cursor = page.cursor;
      pageCount += 1;
      yield* Effect.forEach(
        page.keys,
        (recordKey) =>
          Effect.gen(function* () {
            const encodedDeliveryKey = recordKey.slice(deliveryPrefix.length);
            const deliveryKey = yield* Schema.decodeUnknownEffect(DeliveryKey)(
              encodedDeliveryKey,
            ).pipe(Effect.option);
            if (Option.isNone(deliveryKey)) return;
            const entry = yield* readDeliveryRecord(deliveryKey.value);
            if (
              !Predicate.isNull(entry) &&
              (entry.record.state === "pending" || entry.record.state === "ambiguous")
            ) {
              yield* markUnresolved(deliveryKey.value, entry.record.operation);
            }
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Skipped a delivery record during reservation-index backfill").pipe(
                Effect.annotateLogs({ reason: error.message, recordKey }),
              ),
            ),
          ),
        { concurrency: 16, discard: true },
      );
      if (cursor !== "0") yield* Effect.sleep(deliveryBackfillPageDelay);
    } while (cursor !== "0");
    yield* Effect.logInfo("Completed the delivery reservation index backfill").pipe(
      Effect.annotateLogs({ pageCount }),
    );
  });

  let unresolvedScanCursor = "0";
  let unresolvedScanOverflow: ReadonlyArray<string> = [];
  let unresolvedScanCycleMarkerCount = 0;
  let unresolvedScanCycleCount = 0;
  let unresolvedScanCycleOldestAgeSeconds = 0;
  let unresolvedScanCycleSaturated = false;
  let unresolvedScanHasCompletedCycle = false;
  let unresolvedPublishedMarkerCount = 0;
  let unresolvedPublishedCount = 0;
  let unresolvedPublishedOldestAgeSeconds = 0;
  let unresolvedPublishedSaturated = false;
  const unresolvedScanSemaphore = Semaphore.makeUnsafe(1);

  const inspectUnresolvedMarker = (markerKey: string, now: number) =>
    Effect.gen(function* () {
      const encodedDeliveryKey = markerKey.slice(unresolvedDeliveryPrefix.length);
      const deliveryKey = yield* Schema.decodeUnknownEffect(DeliveryKey)(encodedDeliveryKey).pipe(
        Effect.option,
      );
      if (Option.isNone(deliveryKey)) {
        yield* storageRemove(storage, markerKey).pipe(Effect.ignore);
        return Option.none<number>();
      }
      const entry = yield* readDeliveryRecord(deliveryKey.value);
      if (
        Predicate.isNull(entry) ||
        entry.record.state === "completed" ||
        entry.record.state === "retryable"
      ) {
        yield* storageRemove(storage, markerKey).pipe(Effect.ignore);
        return Option.none<number>();
      }
      return Option.some(effectiveReservationAgeMs(entry.record.reservedAt, now) / 1_000);
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Skipped an unresolved delivery marker during the metric scan").pipe(
          Effect.annotateLogs({ markerKey, reason: error.message }),
          Effect.as(Option.none<number>()),
        ),
      ),
    );

  const loadUnresolvedScanPage = Effect.gen(function* () {
    let scannedKeys = unresolvedScanOverflow;
    let nextCursor = unresolvedScanCursor;
    // Redis COUNT is a hint and may over-return. Only scan when carried overflow is below the
    // inspection limit so the requested page size always remains positive.
    if (
      scannedKeys.length === 0 ||
      (scannedKeys.length < unresolvedInspectionLimit && unresolvedScanCursor !== "0")
    ) {
      const page = yield* storageScanKeys(
        storage,
        unresolvedDeliveryPrefix,
        unresolvedScanCursor,
        unresolvedInspectionLimit + 1 - scannedKeys.length,
      );
      nextCursor = page.cursor;
      scannedKeys = [...scannedKeys, ...page.keys];
    }
    return { scannedKeys, nextCursor } as const;
  });

  const publishUnresolvedScanMetrics = Effect.gen(function* () {
    yield* Metric.update(sheetBotDeliveryUnresolvedReservations, unresolvedPublishedCount);
    yield* Metric.update(
      sheetBotDeliveryOldestUnresolvedAgeSeconds,
      unresolvedPublishedOldestAgeSeconds,
    );
    yield* Metric.update(
      sheetBotDeliveryObservabilitySaturated,
      unresolvedPublishedSaturated ? 1 : 0,
    );
    if (unresolvedPublishedCount > 0 || unresolvedPublishedSaturated) {
      yield* Effect.logWarning("Observed unresolved sheet bot Delivery Key reservations").pipe(
        Effect.annotateLogs({
          inspected: unresolvedPublishedMarkerCount,
          oldestAgeSeconds: unresolvedPublishedOldestAgeSeconds,
          saturated: unresolvedPublishedSaturated,
          unresolved: unresolvedPublishedCount,
        }),
      );
    }
  });

  const captureUnresolvedScanSnapshot = (cycleComplete: boolean) =>
    Effect.sync(() => {
      if (!cycleComplete && unresolvedScanHasCompletedCycle) return;
      unresolvedPublishedMarkerCount = unresolvedScanCycleMarkerCount;
      unresolvedPublishedCount = unresolvedScanCycleCount;
      unresolvedPublishedOldestAgeSeconds = unresolvedScanCycleOldestAgeSeconds;
      unresolvedPublishedSaturated = unresolvedScanCycleSaturated;
      unresolvedScanHasCompletedCycle ||= cycleComplete;
    });

  const resetUnresolvedScanCycle = (cycleComplete: boolean) =>
    Effect.sync(() => {
      if (!cycleComplete) return;
      unresolvedScanCycleMarkerCount = 0;
      unresolvedScanCycleCount = 0;
      unresolvedScanCycleOldestAgeSeconds = 0;
      unresolvedScanCycleSaturated = false;
    });

  // Cursor, overflow, cycle gauges, and marker cleanup form one serialized scan state machine.
  const refreshDeliveryReservationMetrics = unresolvedScanSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const { scannedKeys, nextCursor } = yield* loadUnresolvedScanPage;
      const inspectedKeys = scannedKeys.slice(0, unresolvedInspectionLimit);
      const remainingKeys = scannedKeys.slice(unresolvedInspectionLimit);
      const now = yield* Clock.currentTimeMillis;
      const unresolvedAges = yield* Effect.forEach(
        inspectedKeys,
        (markerKey) => inspectUnresolvedMarker(markerKey, now),
        { concurrency: 16 },
      );
      const unresolved = unresolvedAges.filter(Option.isSome).length;
      const oldestAgeSeconds = unresolvedAges.reduce(
        (oldestAgeSeconds, age) =>
          Option.isSome(age) ? Math.max(oldestAgeSeconds, age.value) : oldestAgeSeconds,
        0,
      );

      unresolvedScanCursor = nextCursor;
      unresolvedScanOverflow = remainingKeys;
      unresolvedScanCycleMarkerCount += inspectedKeys.length;
      unresolvedScanCycleCount += unresolved;
      unresolvedScanCycleOldestAgeSeconds = Math.max(
        unresolvedScanCycleOldestAgeSeconds,
        oldestAgeSeconds,
      );
      unresolvedScanCycleSaturated ||= remainingKeys.length > 0;
      const cycleComplete = remainingKeys.length === 0 && nextCursor === "0";
      yield* captureUnresolvedScanSnapshot(cycleComplete);
      yield* publishUnresolvedScanMetrics;
      yield* resetUnresolvedScanCycle(cycleComplete);
    }),
  );

  const executeDelivery: BotCapabilityStoreShape["executeDelivery"] = (input) =>
    // Delivery reservation, replay, and provider-result transitions form one atomic state machine.
    // fallow-ignore-next-line complexity
    Effect.gen(function* () {
      const inputHash = yield* sha256(stableJson(input.encodedInput));
      const key = deliveryStorageKey(input.deliveryKey);

      for (let attempt = 0; attempt < deliveryTransitionAttempts; attempt += 1) {
        if (attempt > 0) yield* Effect.sleep(deliveryTransitionRetryDelay);
        const now = yield* Clock.currentTimeMillis;
        const pending: typeof pendingDeliveryRecordSchema.Type = {
          state: "pending",
          operation: input.operation,
          inputHash,
          reservationId: crypto.randomUUID(),
          reservedAt: now,
        };
        let claimedPending = pending;
        const reserved = yield* storageSetIfAbsent(storage, key, pending, deliveryRetentionSeconds);

        if (!reserved) {
          const entry = yield* readDeliveryRecord(input.deliveryKey);
          if (Predicate.isNull(entry)) continue;
          const { record } = entry;
          if (record.operation !== input.operation || record.inputHash !== inputHash) {
            return yield* new BotRequestRejected({
              message: "Delivery Key is already bound to a different operation or input",
            });
          }
          if (record.state === "completed")
            return record.receipt as Effect.Success<typeof input.effect>;
          if (record.state === "pending") {
            return yield* new BotDependencyUnavailable({
              message:
                "Delivery attempt is pending; retry after it completes or reconcile it if the attempt was interrupted",
            });
          }
          if (record.state === "ambiguous") {
            return yield* new BotDependencyUnavailable({
              message: "Delivery outcome is ambiguous and requires reconciliation",
            });
          }
          claimedPending = preserveStoredFields(entry.raw, {
            ...pending,
            ...(record.reconciliation === undefined
              ? {}
              : { reconciliation: record.reconciliation }),
          });
          const claimedRetry = yield* storageCompareAndSet(
            storage,
            key,
            entry.raw,
            claimedPending,
            deliveryRetentionSeconds,
          );
          if (!claimedRetry) continue;
        }

        yield* markUnresolved(input.deliveryKey, input.operation).pipe(
          Effect.tapError(() =>
            storageCompareAndRemove(storage, key, claimedPending).pipe(Effect.ignore),
          ),
        );

        return yield* Effect.matchEffect(input.effect, {
          onSuccess: (receipt) =>
            Effect.gen(function* () {
              const completed = preserveStoredFields(claimedPending, {
                state: "completed",
                operation: input.operation,
                inputHash,
                receipt,
                ...(claimedPending.reconciliation === undefined
                  ? {}
                  : { reconciliation: claimedPending.reconciliation }),
              } satisfies DeliveryRecord);
              const transitioned = yield* storageCompareAndSet(
                storage,
                key,
                claimedPending,
                completed,
                deliveryRetentionSeconds,
              );
              if (transitioned) {
                yield* clearUnresolved(input.deliveryKey);
                return receipt;
              }
              const current = yield* readDeliveryRecord(input.deliveryKey);
              if (!Predicate.isNull(current) && current.record.state === "completed") {
                yield* clearUnresolved(input.deliveryKey);
                return current.record.receipt as Effect.Success<typeof input.effect>;
              }
              yield* Effect.logError(
                "Sheet bot delivery committed but its reservation was reconciled concurrently",
              ).pipe(
                Effect.annotateLogs({
                  deliveryKey: input.deliveryKey,
                  observedState: current?.record.state ?? "missing",
                  operation: input.operation,
                  receipt,
                }),
              );
              return yield* unavailable(
                "Delivery completed but its reservation changed during reconciliation",
              );
            }),
          onFailure: (error) =>
            Effect.gen(function* () {
              if (input.isDefinitiveFailure(error)) {
                const removed = yield* storageCompareAndRemove(storage, key, claimedPending);
                if (removed) yield* clearUnresolved(input.deliveryKey);
                return yield* Effect.fail(error);
              }

              const ambiguityRecordedAt = yield* Clock.currentTimeMillis;
              const ambiguous = preserveStoredFields(claimedPending, {
                state: "ambiguous",
                operation: input.operation,
                inputHash,
                reservationId: claimedPending.reservationId,
                reservedAt: claimedPending.reservedAt,
                ambiguityRecordedAt,
                ...(claimedPending.reconciliation === undefined
                  ? {}
                  : { reconciliation: claimedPending.reconciliation }),
              } satisfies DeliveryRecord);
              const transitioned = yield* storageCompareAndSet(
                storage,
                key,
                claimedPending,
                ambiguous,
                deliveryRetentionSeconds,
              );
              if (transitioned) {
                yield* Metric.update(
                  Metric.withAttributes(sheetBotDeliveryAmbiguousOutcomes, {
                    operation: input.operation,
                  }),
                  1,
                );
                yield* Effect.logWarning("Sheet bot delivery outcome is ambiguous").pipe(
                  Effect.annotateLogs({
                    ambiguityRecordedAt,
                    deliveryKey: input.deliveryKey,
                    operation: input.operation,
                    reservedAt: claimedPending.reservedAt,
                  }),
                );
              } else {
                const current = yield* readDeliveryRecord(input.deliveryKey);
                if (!Predicate.isNull(current) && current.record.state === "pending") {
                  yield* Metric.update(
                    Metric.withAttributes(sheetBotDeliveryAmbiguousOutcomes, {
                      operation: input.operation,
                    }),
                    1,
                  );
                }
                yield* Effect.logError(
                  "Sheet bot delivery outcome is ambiguous but its reservation changed concurrently",
                ).pipe(
                  Effect.annotateLogs({
                    ambiguityRecordedAt,
                    deliveryKey: input.deliveryKey,
                    observedState: current?.record.state ?? "missing",
                    operation: input.operation,
                  }),
                );
              }
              return yield* Effect.fail(error);
            }),
        });
      }

      return yield* new BotDependencyUnavailable({
        message: "Delivery Key reservation changed concurrently; retry the delivery",
      });
    });

  return {
    issueResponseReference,
    resolveResponseReference,
    executeDelivery,
    inspectDelivery,
    reconcileDelivery,
    backfillDeliveryReservationIndex,
    refreshDeliveryReservationMetrics,
  } satisfies BotCapabilityStoreShape;
});

export class BotCapabilityStore extends Context.Service<
  BotCapabilityStore,
  BotCapabilityStoreShape
>()("sheet-bot/BotCapabilityStore") {
  static layer = Layer.effect(
    BotCapabilityStore,
    Effect.gen(function* () {
      const store = yield* makeBotCapabilityStore;
      yield* store.backfillDeliveryReservationIndex.pipe(
        Effect.catch((error) =>
          Effect.logWarning("Failed to backfill the delivery reservation index", error),
        ),
        Effect.andThen(
          store.refreshDeliveryReservationMetrics.pipe(
            Effect.catch((error) =>
              Effect.logWarning("Failed to refresh delivery reservation metrics", error),
            ),
            Effect.repeat(Schedule.spaced(observabilityRefreshInterval)),
          ),
        ),
        Effect.forkScoped,
      );
      return store;
    }),
  );
}
