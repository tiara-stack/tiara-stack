import { Clock, Context, Effect, Layer, Predicate, Redacted, Schema } from "effect";
import { Unstorage } from "dfx-discord-utils/discord/cache";
import {
  BotDependencyUnavailable,
  BotDeliveryOperation,
  BotRequestRejected,
  BotResponseExpired,
  ClientRef,
  DeliveryReceipt,
  ResponseReference,
  type ClientRef as ClientRefType,
  type DeliveryKey,
  type DeliveryReceipt as DeliveryReceiptType,
  type ResponseReference as ResponseReferenceType,
} from "sheet-bot-api";
import { config } from "@/config";

const responseRecordSchema = Schema.Struct({
  applicationId: Schema.String,
  client: ClientRef,
  interactionToken: Schema.String,
  permittedOperations: Schema.Array(Schema.Literal("respond")),
  expiresAt: Schema.Number,
});

const encryptedResponseRecordSchema = Schema.Struct({
  iv: Schema.String,
  ciphertext: Schema.String,
});

const pendingDeliveryRecordSchema = Schema.Struct({
  state: Schema.Literal("pending"),
  operation: BotDeliveryOperation,
  inputHash: Schema.String,
});

const completedDeliveryRecordSchema = Schema.Struct({
  state: Schema.Literal("completed"),
  operation: BotDeliveryOperation,
  inputHash: Schema.String,
  receipt: DeliveryReceipt,
});

const deliveryRecordSchema = Schema.Union([
  pendingDeliveryRecordSchema,
  completedDeliveryRecordSchema,
]);

type ResponseRecord = typeof responseRecordSchema.Type;
type DeliveryRecord = typeof deliveryRecordSchema.Type;

const responsePrefix = "capabilities:responses:";
const deliveryPrefix = "capabilities:deliveries:";
const deliveryRetentionSeconds = 60 * 60 * 24 * 30;

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

  const executeDelivery: BotCapabilityStoreShape["executeDelivery"] = (input) =>
    Effect.gen(function* () {
      const inputHash = yield* sha256(stableJson(input.encodedInput));
      const key = `${deliveryPrefix}${input.deliveryKey}`;
      const pending: DeliveryRecord = {
        state: "pending",
        operation: input.operation,
        inputHash,
      };
      const reserved = yield* storageSetIfAbsent(storage, key, pending, deliveryRetentionSeconds);

      if (!reserved) {
        const stored = yield* storageGet(storage, key);
        if (Predicate.isNull(stored)) {
          return yield* new BotDependencyUnavailable({
            message: "Delivery reservation disappeared before it could be inspected",
          });
        }
        const record = yield* decodeStored(deliveryRecordSchema, stored, "Delivery Key");
        if (record.operation !== input.operation || record.inputHash !== inputHash) {
          return yield* new BotRequestRejected({
            message: "Delivery Key is already bound to a different operation or input",
          });
        }
        if (record.state === "completed")
          return record.receipt as Effect.Success<typeof input.effect>;
        return yield* new BotDependencyUnavailable({
          message: "Delivery outcome is ambiguous and requires reconciliation",
        });
      }

      return yield* Effect.matchEffect(input.effect, {
        onSuccess: (receipt) =>
          storageSet(
            storage,
            key,
            {
              state: "completed",
              operation: input.operation,
              inputHash,
              receipt,
            } satisfies DeliveryRecord,
            deliveryRetentionSeconds,
          ).pipe(Effect.as(receipt)),
        onFailure: (error) =>
          (input.isDefinitiveFailure(error)
            ? storageRemove(storage, key).pipe(Effect.ignore)
            : Effect.void
          ).pipe(Effect.andThen(Effect.fail(error))),
      });
    });

  return {
    issueResponseReference,
    resolveResponseReference,
    executeDelivery,
  } satisfies BotCapabilityStoreShape;
});

export class BotCapabilityStore extends Context.Service<
  BotCapabilityStore,
  BotCapabilityStoreShape
>()("sheet-bot/BotCapabilityStore") {
  static layer = Layer.effect(BotCapabilityStore, makeBotCapabilityStore);
}
