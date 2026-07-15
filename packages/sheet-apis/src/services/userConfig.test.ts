import { describe, expect, it } from "@effect/vitest";
import { Cause, DateTime, Effect, Exit, Option } from "effect";
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
  readonly deletedAt?: Option.Option<DateTime.Utc>;
}) =>
  new UserPlatformConfig({
    platform: "discord",
    userId: overrides.userId,
    defaultClientId: overrides.defaultClientId ?? Option.some("discord-main"),
    checkinDmEnabled: overrides.checkinDmEnabled ?? false,
    monitorDmEnabled: overrides.monitorDmEnabled ?? true,
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: overrides.deletedAt ?? Option.none(),
  });

const run = <A, E>(
  effect: (service: typeof UserConfigService.Service) => Effect.Effect<A, E, never>,
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

const runPartialCheckinUpdate = (
  existing: Option.Option<UserPlatformConfig>,
  updated: UserPlatformConfig,
) =>
  Effect.gen(function* () {
    const mutationCalls: Array<unknown> = [];
    const readCalls: Array<unknown> = [];
    const result = yield* run(
      (service) =>
        service.upsertUserPlatformConfig("discord", "monitor-1", {
          checkinDmEnabled: false,
        }),
      {
        zero: {
          userConfig: {
            getUserPlatformConfig: (args: unknown) => {
              readCalls.push(args);
              return Effect.succeed(readCalls.length === 1 ? existing : Option.some(updated));
            },
            upsertUserPlatformConfig: (args: unknown) => {
              mutationCalls.push(args);
              return Effect.void;
            },
          },
        },
      },
    );
    return { mutationCalls, readCalls, result };
  });

const expectedPartialCheckinMutation = {
  platform: "discord",
  userId: "monitor-1",
  checkinDmEnabled: false,
};
const expectedConfigReads = [
  { platform: "discord", userId: "monitor-1" },
  { platform: "discord", userId: "monitor-1" },
];
const expectPartialCheckinUpdate = (
  outcome: {
    readonly mutationCalls: ReadonlyArray<unknown>;
    readonly readCalls: ReadonlyArray<unknown>;
    readonly result: UserPlatformConfig;
  },
  updated: UserPlatformConfig,
) => {
  expect(outcome.result).toEqual(updated);
  expect(outcome.readCalls).toEqual(expectedConfigReads);
  expect(outcome.mutationCalls).toEqual([expectedPartialCheckinMutation]);
};

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
      const mutationCalls: Array<unknown> = [];
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
                upsertUserPlatformConfig: (...args: ReadonlyArray<unknown>) =>
                  Effect.sync(() => {
                    mutationCalls.push(args);
                  }),
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
      expect(mutationCalls).toEqual([]);
    }),
  );

  it.effect("forwards preference mutations as partial atomic updates", () =>
    Effect.gen(function* () {
      const updated = makeConfig({
        userId: "monitor-1",
        defaultClientId: Option.none(),
        checkinDmEnabled: false,
        monitorDmEnabled: false,
      });

      const outcome = yield* runPartialCheckinUpdate(Option.none(), updated);

      expectPartialCheckinUpdate(outcome, updated);
    }),
  );

  it.effect("treats soft-deleted preferences as absent for partial updates", () =>
    Effect.gen(function* () {
      const deleted = makeConfig({
        userId: "monitor-1",
        checkinDmEnabled: true,
        monitorDmEnabled: true,
        deletedAt: Option.some(DateTime.makeUnsafe("2026-07-14T00:00:00.000Z")),
      });
      const updated = makeConfig({
        userId: "monitor-1",
        defaultClientId: Option.none(),
        checkinDmEnabled: false,
        monitorDmEnabled: false,
      });
      const outcome = yield* runPartialCheckinUpdate(Option.some(deleted), updated);

      expectPartialCheckinUpdate(outcome, updated);
    }),
  );
});
