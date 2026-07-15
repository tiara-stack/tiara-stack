import { Schema } from "effect";
import { makeArgumentError } from "typhoon-core/error";
import { ZeroApiEndpoint, ZeroApiGroup } from "typhoon-zero/zeroApi";
import { zeroTableAccess } from "../accessors";
import { activeRecord, preserveOmitted } from "../timestamps";
import type { SheetZeroApiSuccessSchemas } from "./successSchemas";

const resolveDmEnabled = (requested: boolean | undefined, existing: boolean | undefined) =>
  requested ?? existing ?? false;

const validateDmPreferences = (
  checkinDmEnabled: boolean,
  monitorDmEnabled: boolean,
  defaultClientId: string | null | undefined,
) => {
  if ((checkinDmEnabled || monitorDmEnabled) && !defaultClientId) {
    throw makeArgumentError("A default notification client is required to enable DMs");
  }
};

const enabledUserConfigsQuery =
  (field: "checkinDmEnabled" | "monitorDmEnabled") =>
  ({
    args: { platform, userIds },
  }: {
    args: { platform: string; userIds: ReadonlyArray<string> };
  }) =>
    zeroTableAccess.configUserPlatform.listActiveWhere(
      zeroTableAccess.configUserPlatform.table
        .where("platform", "=", platform)
        .where("userId", "IN", userIds)
        .where(field, "=", true)
        .where("defaultClientId", "IS NOT", null),
    );

export const makeUserConfigGroup = <const SuccessSchemas extends SheetZeroApiSuccessSchemas>(
  success: SuccessSchemas,
) =>
  ZeroApiGroup.make("userConfig").add(
    ZeroApiEndpoint.query("getUserPlatformConfig", {
      request: Schema.Struct({
        platform: Schema.String,
        userId: Schema.String,
      }),
      success: success.userConfig.getUserPlatformConfig,
      query: ({ args: { platform, userId } }) =>
        zeroTableAccess.configUserPlatform.getActiveByPrimaryKey(
          zeroTableAccess.configUserPlatform.table,
          {
            platform,
            userId,
          },
        ),
    }),
    ZeroApiEndpoint.query("getCheckinDmEnabledUserConfigs", {
      request: Schema.Struct({
        platform: Schema.String,
        userIds: Schema.Array(Schema.String),
      }),
      success: success.userConfig.getCheckinDmEnabledUserConfigs,
      query: enabledUserConfigsQuery("checkinDmEnabled"),
    }),
    ZeroApiEndpoint.query("getMonitorDmEnabledUserConfigs", {
      request: Schema.Struct({
        platform: Schema.String,
        userIds: Schema.Array(Schema.String),
      }),
      success: success.userConfig.getMonitorDmEnabledUserConfigs,
      query: enabledUserConfigsQuery("monitorDmEnabled"),
    }),
    ZeroApiEndpoint.mutator("upsertUserPlatformConfig", {
      request: Schema.Struct({
        platform: Schema.String,
        userId: Schema.String,
        checkinDmEnabled: Schema.optional(Schema.Boolean),
        monitorDmEnabled: Schema.optional(Schema.Boolean),
        defaultClientId: Schema.optional(Schema.NullOr(Schema.String)),
      }),
      mutator: async ({ tx, args }) => {
        const existingConfig = await tx.run(
          zeroTableAccess.configUserPlatform.table
            .where("platform", "=", args.platform)
            .where("userId", "=", args.userId)
            .one(),
        );
        const activeExistingConfig = activeRecord(existingConfig);
        const checkinDmEnabled = resolveDmEnabled(
          args.checkinDmEnabled,
          activeExistingConfig?.checkinDmEnabled,
        );
        const monitorDmEnabled = resolveDmEnabled(
          args.monitorDmEnabled,
          activeExistingConfig?.monitorDmEnabled,
        );
        const defaultClientId = preserveOmitted(
          args.defaultClientId,
          activeExistingConfig?.defaultClientId,
        );
        validateDmPreferences(checkinDmEnabled, monitorDmEnabled, defaultClientId);

        await tx.mutate.configUserPlatform.upsert(
          zeroTableAccess.configUserPlatform.upsertWithTimestamps(
            {
              platform: args.platform,
              userId: args.userId,
              checkinDmEnabled,
              monitorDmEnabled,
              defaultClientId,
              deletedAt: null,
            },
            activeExistingConfig,
          ),
        );
      },
    }),
  );

export type UserConfigGroup<SuccessSchemas extends SheetZeroApiSuccessSchemas> = ReturnType<
  typeof makeUserConfigGroup<SuccessSchemas>
>;
