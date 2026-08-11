import { Context, Data, Effect, Layer, Option, Predicate, Schema } from "effect";
import type { EffectivePrincipal } from "sheet-auth/identity";
import { DeliveryKey, type DeliveryReceipt, type SheetBotHttpClient } from "sheet-bot-api";
import {
  InteractiveDeclaredFailure,
  type PreferenceKind,
  type PreferencesUpdateAndDeliverInput,
} from "sheet-workflow-contracts";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { config } from "@/config";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  interactiveInvalidRequest as invalidRequest,
  mapDeliveryFailure,
  requireInteractiveDiscordAccountId,
} from "../shared/interactive";

export const PreferenceState = Schema.Struct({
  platform: Schema.String,
  checkinDmEnabled: Schema.Boolean,
  monitorDmEnabled: Schema.Boolean,
  defaultClientId: Schema.NullOr(Schema.String),
});
export type PreferenceState = typeof PreferenceState.Type;

class PreferencesWorkflowOperationsError extends Data.TaggedError(
  "PreferencesWorkflowOperationsError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type PreferencesResult<A> = Effect.Effect<
  A,
  InteractiveDeclaredFailure | PreferencesWorkflowOperationsError
>;

interface PreferencesWorkflowOperationsShape {
  readonly load: (
    principal: EffectivePrincipal,
    platform: string,
    policy: string,
  ) => PreferencesResult<PreferenceState>;
  readonly update: (
    principal: EffectivePrincipal,
    input: PreferencesUpdateAndDeliverInput,
    current: PreferenceState,
    policy: string,
  ) => PreferencesResult<PreferenceState>;
  readonly deliver: (
    input: {
      readonly responseReference: Parameters<
        SheetBotHttpClient["delivery"]["respond"]
      >[0]["payload"]["responseReference"];
    },
    state: PreferenceState,
    deliveryKey: typeof DeliveryKey.Type,
    headline: string,
    policy: string,
    options: { readonly recoveryRequired: boolean },
  ) => PreferencesResult<DeliveryReceipt>;
}

export class PreferencesWorkflowOperations extends Context.Service<
  PreferencesWorkflowOperations,
  PreferencesWorkflowOperationsShape
>()("sheet-workflows/PreferencesWorkflowOperations") {}

const disabledState = (platform: string): PreferenceState => ({
  platform,
  checkinDmEnabled: false,
  monitorDmEnabled: false,
  defaultClientId: null,
});

const stateFromRow = (
  row: Option.Option<{
    readonly checkinDmEnabled: boolean;
    readonly defaultClientId: string | null;
    readonly monitorDmEnabled: boolean;
  }>,
  platform: string,
): PreferenceState =>
  Option.match(row, {
    onNone: () => disabledState(platform),
    onSome: ({ checkinDmEnabled, defaultClientId, monitorDmEnabled }) => ({
      platform,
      checkinDmEnabled,
      monitorDmEnabled,
      defaultClientId,
    }),
  });

const preferenceMessage = (headline: string, state: PreferenceState) => ({
  content: [
    headline,
    `Platform: ${state.platform}`,
    `Default client: ${state.defaultClientId ?? "not set"}`,
    `Check-in reminders: ${state.checkinDmEnabled ? "enabled" : "disabled"}`,
    `Monitor pings: ${state.monitorDmEnabled ? "enabled" : "disabled"}`,
  ].join("\n"),
  allowedMentions: "none" as const,
});

const operationError = (operation: string, cause: unknown) =>
  new PreferencesWorkflowOperationsError({ operation, cause });

export const preferenceStatusHeadline = (kind: PreferenceKind, state: PreferenceState): string => {
  const settings = {
    checkin: {
      label: "Check-in DM reminders",
      enabled: state.checkinDmEnabled,
    },
    monitor: {
      label: "Monitor DM pings",
      enabled: state.monitorDmEnabled,
    },
  } as const;
  const setting = settings[kind];
  return `${setting.label} are ${setting.enabled ? "enabled" : "disabled"}.`;
};

export const preferencesWorkflowOperationsLayer = Layer.effect(
  PreferencesWorkflowOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const delivery = yield* SheetBotDeliveryClient;
    const supportedClientId = yield* config.sheetBotClientId;

    // Preference delivery is intentionally Discord-only until another bot delivery adapter exists.
    const requireSupportedPlatform = (platform: string) =>
      platform === "discord"
        ? Effect.void
        : Effect.fail(
            invalidRequest(
              "UnsupportedNotificationPlatform",
              `Unsupported notification platform: ${platform}`,
            ),
          );

    const load: PreferencesWorkflowOperationsShape["load"] = (principal, platform, policy) =>
      Effect.gen(function* () {
        yield* requireSupportedPlatform(platform);
        const userId = yield* requireInteractiveDiscordAccountId(principal, policy);
        const row = yield* persistence.preferences.getUserPlatformConfig({ platform, userId }).pipe(
          Effect.mapError(
            (cause) =>
              new PreferencesWorkflowOperationsError({
                operation: "preferences.load",
                cause,
              }),
          ),
        );
        return stateFromRow(row, platform);
      });

    const update: PreferencesWorkflowOperationsShape["update"] = (
      principal,
      input,
      current,
      policy,
    ) =>
      Effect.gen(function* () {
        yield* requireSupportedPlatform(input.platform);
        const userId = yield* requireInteractiveDiscordAccountId(principal, policy);
        const next: PreferenceState = {
          ...current,
          platform: input.platform,
          ...(Predicate.isUndefined(input.checkinDmEnabled)
            ? {}
            : { checkinDmEnabled: input.checkinDmEnabled }),
          ...(Predicate.isUndefined(input.monitorDmEnabled)
            ? {}
            : { monitorDmEnabled: input.monitorDmEnabled }),
          ...(Predicate.isUndefined(input.defaultClientId)
            ? {}
            : { defaultClientId: input.defaultClientId }),
        };
        if (
          Predicate.isString(next.defaultClientId) &&
          next.defaultClientId !== supportedClientId
        ) {
          return yield* Effect.fail(
            invalidRequest(
              "UnsupportedNotificationClient",
              `Unsupported notification client: ${input.platform}:${next.defaultClientId}`,
            ),
          );
        }
        if (
          (next.checkinDmEnabled || next.monitorDmEnabled) &&
          Predicate.isNull(next.defaultClientId)
        ) {
          return yield* Effect.fail(
            invalidRequest(
              "DefaultNotificationClientRequired",
              "A default notification client is required to enable DMs",
            ),
          );
        }
        yield* persistence.preferences
          .upsertUserPlatformConfig({
            platform: next.platform,
            userId,
            checkinDmEnabled: next.checkinDmEnabled,
            monitorDmEnabled: next.monitorDmEnabled,
            defaultClientId: next.defaultClientId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PreferencesWorkflowOperationsError({
                  operation: "preferences.update",
                  cause,
                }),
            ),
          );
        return next;
      });

    const deliver: PreferencesWorkflowOperationsShape["deliver"] = (
      input,
      state,
      deliveryKey,
      headline,
      policy,
      { recoveryRequired },
    ) =>
      delivery
        .get()
        .delivery.respond({
          payload: {
            responseReference: input.responseReference,
            deliveryKey,
            message: preferenceMessage(headline, state),
          },
        })
        .pipe(
          Effect.mapError(
            mapDeliveryFailure(
              policy,
              "preferences.respond",
              "response",
              recoveryRequired,
              "The preference response was rejected",
              operationError,
            ),
          ),
        );

    return { deliver, load, update };
  }),
);
