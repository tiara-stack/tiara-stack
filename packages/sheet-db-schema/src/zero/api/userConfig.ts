import { Schema } from "effect";
import { ZeroApiEndpoint, ZeroApiGroup } from "typhoon-zero/zeroApi";
import { zeroTableAccess } from "../accessors";
import { preserveOmitted } from "../timestamps";
import type { SheetZeroApiSuccessSchemas } from "./successSchemas";

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
        checkinDmEnabled: Schema.Boolean,
        monitorDmEnabled: Schema.Boolean,
        defaultClientId: Schema.optional(Schema.NullOr(Schema.String)),
      }),
      mutator: async ({ tx, args }) => {
        const existingConfig = await tx.run(
          zeroTableAccess.configUserPlatform.table
            .where("platform", "=", args.platform)
            .where("userId", "=", args.userId)
            .one(),
        );

        await tx.mutate.configUserPlatform.upsert(
          zeroTableAccess.configUserPlatform.upsertWithTimestamps(
            {
              platform: args.platform,
              userId: args.userId,
              checkinDmEnabled: args.checkinDmEnabled,
              monitorDmEnabled: args.monitorDmEnabled,
              defaultClientId: preserveOmitted(
                args.defaultClientId,
                existingConfig?.defaultClientId,
              ),
              deletedAt: null,
            },
            existingConfig,
          ),
        );
      },
    }),
  );

export type UserConfigGroup<SuccessSchemas extends SheetZeroApiSuccessSchemas> = ReturnType<
  typeof makeUserConfigGroup<SuccessSchemas>
>;
