import { Effect, Option } from "effect";
import type {
  PreferenceDmDisableDispatchPayload,
  PreferenceDmEnableDispatchPayload,
  PreferenceDmSetClientDispatchPayload,
  PreferenceDmStatusDispatchPayload,
} from "sheet-ingress-api/sheet-apis-rpc";
import type { DispatchRequester } from "sheet-ingress-api/sheet-workflows-workflows";
import { makeSheetApisServices } from "../clients/sheetApis";
import { makePreferenceDmHelpers } from "./preferences";

type UserConfigService = ReturnType<typeof makeSheetApisServices>["userConfigService"];
type PreferenceDmHelpers = ReturnType<typeof makePreferenceDmHelpers>;

const resolvePlatform = (platform: string | null | undefined) => platform ?? "discord";

export const makePreferenceDmOperations = ({
  helpers,
  userConfigService,
}: {
  readonly helpers: PreferenceDmHelpers;
  readonly userConfigService: UserConfigService;
}) => {
  const {
    disabledPreferenceDmResult,
    dmKindEnabled,
    dmKindLabel,
    preferenceDmResultFromConfig,
    respondPreferenceDm,
  } = helpers;
  const dmKindUpdate = {
    checkin: (enabled: boolean) => ({ checkinDmEnabled: enabled }),
    monitor: (enabled: boolean) => ({ monitorDmEnabled: enabled }),
  } as const;
  const updateDmPreference = Effect.fn("DispatchService.updateDmPreference")(function* ({
    kind,
    enabled,
    defaultClientId,
    interactionResponseToken,
    platform: requestedPlatform,
    requester,
    statusText,
  }: {
    readonly kind: PreferenceDmEnableDispatchPayload["kind"];
    readonly enabled: boolean;
    readonly defaultClientId?: string | null | undefined;
    readonly interactionResponseToken: string;
    readonly platform: string | null | undefined;
    readonly requester: DispatchRequester;
    readonly statusText: string;
  }) {
    const platform = resolvePlatform(requestedPlatform);
    yield* Effect.annotateCurrentSpan({ accountId: requester.accountId, platform });
    const config = yield* userConfigService.upsertUserPlatformConfig(
      platform,
      requester.accountId,
      {
        ...dmKindUpdate[kind](enabled),
        ...(enabled && defaultClientId !== undefined ? { defaultClientId } : {}),
      },
    );
    const result = preferenceDmResultFromConfig(config);
    yield* respondPreferenceDm(interactionResponseToken, statusText, result);
    return result;
  });

  return {
    preferenceDmStatus: Effect.fn("DispatchService.preferenceDmStatus")(function* (
      payload: PreferenceDmStatusDispatchPayload,
      requester: DispatchRequester,
    ) {
      const platform = resolvePlatform(payload.platform);
      const config = yield* userConfigService.getUserPlatformConfig(platform, requester.accountId);
      const result = Option.match(config, {
        onNone: () => disabledPreferenceDmResult(platform),
        onSome: preferenceDmResultFromConfig,
      });

      yield* respondPreferenceDm(
        payload.interactionResponseToken,
        `${dmKindLabel(payload.kind)} are ${
          dmKindEnabled(result, payload.kind) ? "enabled" : "disabled"
        }.`,
        result,
      );

      return result;
    }),
    preferenceDmEnable: Effect.fn("DispatchService.preferenceDmEnable")(function* (
      payload: PreferenceDmEnableDispatchPayload,
      requester: DispatchRequester,
    ) {
      return yield* updateDmPreference({
        kind: payload.kind,
        enabled: true,
        defaultClientId: payload.defaultClientId,
        interactionResponseToken: payload.interactionResponseToken,
        platform: payload.platform,
        requester,
        statusText: `${dmKindLabel(payload.kind)} are enabled.`,
      });
    }),
    preferenceDmDisable: Effect.fn("DispatchService.preferenceDmDisable")(function* (
      payload: PreferenceDmDisableDispatchPayload,
      requester: DispatchRequester,
    ) {
      return yield* updateDmPreference({
        kind: payload.kind,
        enabled: false,
        interactionResponseToken: payload.interactionResponseToken,
        platform: payload.platform,
        requester,
        statusText: `${dmKindLabel(payload.kind)} are disabled.`,
      });
    }),
    preferenceDmSetClient: Effect.fn("DispatchService.preferenceDmSetClient")(function* (
      payload: PreferenceDmSetClientDispatchPayload,
      requester: DispatchRequester,
    ) {
      const platform = resolvePlatform(payload.platform);
      const config = yield* userConfigService.upsertUserPlatformConfig(
        platform,
        requester.accountId,
        {
          defaultClientId: payload.defaultClientId,
        },
      );
      const result = preferenceDmResultFromConfig(config);

      yield* respondPreferenceDm(
        payload.interactionResponseToken,
        "Shared DM client updated.",
        result,
      );

      return result;
    }),
  };
};
