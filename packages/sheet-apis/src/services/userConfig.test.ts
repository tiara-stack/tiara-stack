import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { ArgumentError } from "typhoon-core/error";
import { UserPlatformConfig } from "sheet-ingress-api/schemas/userConfig";
import { IngressBotClient } from "./ingressBotClient";
import { SheetZeroClient } from "./sheetZeroClient";
import { UserConfigService } from "./userConfig";

const makeConfig = (overrides: {
  readonly userId: string;
  readonly defaultClientId?: Option.Option<string>;
  readonly checkinDmEnabled?: boolean;
  readonly monitorDmEnabled?: boolean;
}) =>
  new UserPlatformConfig({
    platform: "discord",
    userId: overrides.userId,
    defaultClientId: overrides.defaultClientId ?? Option.some("discord-main"),
    checkinDmEnabled: overrides.checkinDmEnabled ?? false,
    monitorDmEnabled: overrides.monitorDmEnabled ?? true,
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
  });

const run = <A, E>(
  effect: (service: typeof UserConfigService.Service) => Effect.Effect<A, E>,
  options: {
    readonly zero: unknown;
    readonly ingressBotClient?: unknown;
  },
) =>
  Effect.gen(function* () {
    const service = yield* UserConfigService.make;
    return yield* effect(service);
  }).pipe(
    Effect.provideService(SheetZeroClient, options.zero as never),
    Effect.provideService(
      IngressBotClient,
      (options.ingressBotClient ?? { listClients: () => Effect.succeed([]) }) as never,
    ),
  );

const firstFailure = <E>(exit: Exit.Exit<unknown, E>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

describe("UserConfigService", () => {
  it.effect("resolves monitor DM recipients from monitor opt-in configs", () =>
    Effect.gen(function* () {
      const queryCalls: Array<unknown> = [];
      const recipients = yield* run(
        (service) => service.getMonitorDmRecipients("discord", ["monitor-1", "monitor-1"]),
        {
          zero: {
            userConfig: {
              getMonitorDmEnabledUserConfigs: (args: unknown) => {
                queryCalls.push(args);
                return Effect.succeed([
                  makeConfig({ userId: "monitor-1" }),
                  makeConfig({
                    userId: "monitor-2",
                    defaultClientId: Option.none(),
                  }),
                ]);
              },
            },
          },
        },
      );

      expect(queryCalls).toEqual([{ platform: "discord", userIds: ["monitor-1"] }]);
      expect(recipients).toEqual([
        {
          platform: "discord",
          userId: "monitor-1",
          defaultClientId: "discord-main",
        },
      ]);
    }),
  );

  it.effect("requires a default client before enabling monitor DMs", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        run(
          (service) =>
            service.upsertUserPlatformConfig("discord", "monitor-1", {
              checkinDmEnabled: false,
              monitorDmEnabled: true,
              defaultClientId: null,
            }),
          {
            zero: {
              userConfig: {
                getUserPlatformConfig: () => Effect.succeed(Option.none()),
                upsertUserPlatformConfig: () => Effect.die("upsert should not run"),
              },
            },
          },
        ),
      );

      const failure = firstFailure(exit);
      expect(failure).toBeInstanceOf(ArgumentError);
      expect(failure).toMatchObject({
        _tag: "ArgumentError",
        message: "A default notification client is required to enable DMs",
      });
    }),
  );
});
