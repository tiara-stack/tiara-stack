import { useAtomSet, useAtomSuspense } from "@effect/atom-react";
import { DateTime, Duration, Effect, Option, Schema } from "effect";
import { Atom, AsyncResult, Reactivity } from "effect/unstable/reactivity";
import { useCallback } from "react";
import { api as sheetZeroApi } from "sheet-zero-api";
import {
  ConfigUserPlatformRow,
  type ConfigUserPlatformRow as ConfigUserPlatformRowType,
} from "sheet-zero-api/rows";
import {
  NotificationsLoadSupportedClientsInput,
  NotificationsLoadSupportedClientsSuccess,
} from "sheet-workflow-contracts";
import {
  SupportedNotificationClient,
  UserPlatformConfig,
} from "sheet-ingress-api/schemas/userConfig";
import { currentUserAtom } from "#/lib/discord";
import { runtimeAtom } from "#/lib/runtime";
import { sheetZeroClientAtom } from "#/lib/sheetZero";
import { runSheetWorkflow } from "#/lib/sheetZero";
import { makeQuery } from "typhoon-zero/zeroApiAtom";

const userConfigReactivityKey = "userConfig";

const userPlatformConfigFromRow = (row: ConfigUserPlatformRowType): UserPlatformConfig =>
  new UserPlatformConfig({
    platform: row.platform,
    userId: row.userId,
    defaultClientId: Option.fromNullishOr(row.defaultClientId),
    checkinDmEnabled: row.checkinDmEnabled,
    monitorDmEnabled: row.monitorDmEnabled,
    createdAt: Option.some(DateTime.makeUnsafe(row.createdAt)),
    updatedAt: Option.some(DateTime.makeUnsafe(row.updatedAt)),
    deletedAt: Option.map(Option.fromNullishOr(row.deletedAt), DateTime.makeUnsafe),
  });

const discordUserPlatformConfigAtom = Atom.make<Option.Option<UserPlatformConfig>, unknown>(
  Effect.fnUntraced(function* (get) {
    const runtime = yield* get.result(sheetZeroClientAtom);
    const user = yield* get.result(currentUserAtom);
    const row = yield* get.result(
      makeQuery(runtime.sheet, sheetZeroApi.userConfig.getUserPlatformConfig, {
        platform: "discord",
        userId: user.id,
      }),
    );
    const decodedRow = yield* Schema.decodeUnknownEffect(
      Schema.OptionFromNullishOr(ConfigUserPlatformRow),
    )(row);
    return Option.map(decodedRow, userPlatformConfigFromRow);
  }),
).pipe(
  Atom.setIdleTTL(Duration.minutes(5)),
  Atom.serializable({
    key: "userConfig.getCurrentUserPlatformConfig",
    schema: Schema.revealCodec(
      AsyncResult.Schema({
        success: Schema.OptionFromNullishOr(UserPlatformConfig),
        error: Schema.Unknown,
      }),
    ),
  }),
);

const supportedNotificationClientsAtom = Atom.make<
  Schema.Schema.Type<typeof NotificationsLoadSupportedClientsSuccess>,
  unknown
>(
  Effect.fnUntraced(function* (get) {
    const runtime = yield* get.result(sheetZeroClientAtom);
    const input = yield* Schema.decodeUnknownEffect(NotificationsLoadSupportedClientsInput)({
      platform: "discord",
    });
    return yield* runSheetWorkflow(
      runtime.workflows.notifications.loadSupportedClients,
      input,
      NotificationsLoadSupportedClientsSuccess,
    );
  }),
).pipe(
  Atom.setIdleTTL(Duration.minutes(5)),
  Atom.serializable({
    key: "notifications.loadSupportedClients.discord",
    schema: Schema.revealCodec(
      AsyncResult.Schema({
        success: NotificationsLoadSupportedClientsSuccess,
        error: Schema.Unknown,
      }),
    ),
  }),
);

type UpsertCurrentUserPlatformConfigPayload = {
  readonly platform: string;
  readonly checkinDmEnabled: boolean;
  readonly monitorDmEnabled: boolean;
  readonly defaultClientId?: string | null | undefined;
};

const upsertCurrentUserPlatformConfigAtom = runtimeAtom.fn(
  Effect.fnUntraced(function* (
    payload: UpsertCurrentUserPlatformConfigPayload,
    ctx: Atom.FnContext,
  ) {
    const runtime = yield* ctx.result(sheetZeroClientAtom);
    const user = yield* ctx.result(currentUserAtom);
    yield* runtime.sheet.grouped.userConfig.upsertUserPlatformConfig({
      ...payload,
      userId: user.id,
    });
    yield* Reactivity.invalidate([userConfigReactivityKey]);
  }),
);

export const useDiscordUserPlatformConfigResult = () =>
  useAtomSuspense(discordUserPlatformConfigAtom, {
    suspendOnWaiting: false,
    includeFailure: true,
  });

export const useSupportedNotificationClientsResult = () =>
  useAtomSuspense(supportedNotificationClientsAtom, {
    suspendOnWaiting: false,
    includeFailure: true,
  });

export const useUpsertCurrentUserPlatformConfig = () => {
  const mutate = useAtomSet(upsertCurrentUserPlatformConfigAtom, { mode: "promise" });
  return useCallback(
    (payload: UpsertCurrentUserPlatformConfigPayload) => mutate(payload) as Promise<void>,
    [mutate],
  );
};

export type { SupportedNotificationClient, UserPlatformConfig };
