import { Option } from "effect";
import type {
  PreferenceDmDispatchResult,
  PreferenceDmStatusDispatchPayload,
} from "sheet-ingress-api/sheet-apis-rpc";
import { ClientDeliveryClient } from "../../clientDeliveryClient";

type PreferenceDmKind = PreferenceDmStatusDispatchPayload["kind"];

export const makePreferenceDmHelpers = (botClient: typeof ClientDeliveryClient.Service) => {
  const preferenceDmResultFromConfig = (platformConfig: {
    readonly platform: string;
    readonly checkinDmEnabled: boolean;
    readonly monitorDmEnabled: boolean;
    readonly defaultClientId: Option.Option<string>;
  }): PreferenceDmDispatchResult => ({
    platform: platformConfig.platform,
    checkinDmEnabled: platformConfig.checkinDmEnabled,
    monitorDmEnabled: platformConfig.monitorDmEnabled,
    defaultClientId: Option.getOrNull(platformConfig.defaultClientId),
  });

  const disabledPreferenceDmResult = (platform: string): PreferenceDmDispatchResult => ({
    platform,
    checkinDmEnabled: false,
    monitorDmEnabled: false,
    defaultClientId: null,
  });

  const dmKindSettings = {
    checkin: {
      label: "Check-in DM reminders",
      enabled: (result: PreferenceDmDispatchResult) => result.checkinDmEnabled,
    },
    monitor: {
      label: "Monitor DM pings",
      enabled: (result: PreferenceDmDispatchResult) => result.monitorDmEnabled,
    },
  } satisfies Record<
    PreferenceDmKind,
    {
      readonly label: string;
      readonly enabled: (result: PreferenceDmDispatchResult) => boolean;
    }
  >;

  const dmKindLabel = (kind: PreferenceDmKind) => dmKindSettings[kind].label;

  const dmKindEnabled = (result: PreferenceDmDispatchResult, kind: PreferenceDmKind) =>
    dmKindSettings[kind].enabled(result);

  const respondPreferenceDm = (
    interactionResponseToken: string,
    headline: string,
    result: PreferenceDmDispatchResult,
  ) =>
    botClient.updateOriginalInteractionResponse(interactionResponseToken, {
      content: [
        headline,
        `Platform: ${result.platform}`,
        `Default client: ${result.defaultClientId ?? "not set"}`,
        `Check-in reminders: ${result.checkinDmEnabled ? "enabled" : "disabled"}`,
        `Monitor pings: ${result.monitorDmEnabled ? "enabled" : "disabled"}`,
      ].join("\n"),
      allowedMentions: "none",
    });

  return {
    disabledPreferenceDmResult,
    dmKindEnabled,
    dmKindLabel,
    preferenceDmResultFromConfig,
    respondPreferenceDm,
  };
};
