import { describe, expect, it, layer } from "@effect/vitest";
import { Cause, Context, DateTime, Effect, Exit, Layer, Option } from "effect";
import { ArgumentError } from "typhoon-core/error";
import { UserPlatformConfig } from "sheet-ingress-api/schemas/userConfig";
import { makeTestSheetZeroClient, type TestSheetZero } from "../testdb";
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
    Effect.provideService(SheetZeroClient, options.zero as typeof SheetZeroClient.Service),
    Effect.provideService(
      IngressBotClient,
      (options.ingressBotClient ?? {
        listClients: () => Effect.succeed([]),
      }) as typeof IngressBotClient.Service,
    ),
  );

const firstFailure = <E>(exit: Exit.Exit<unknown, E>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

const StatefulTestZero = Context.Service<TestSheetZero>("StatefulTestZero");
const StatefulTestZeroLayer = Layer.effect(StatefulTestZero, makeTestSheetZeroClient());

const runStatefulPartialCheckinUpdate = (testZero: TestSheetZero, deletedAt: number | null) =>
  Effect.gen(function* () {
    yield* testZero.reset;
    if (deletedAt !== null) {
      yield* testZero.seed({
        configUserPlatform: [
          {
            platform: "discord",
            userId: "monitor-1",
            defaultClientId: "discord-main",
            checkinDmEnabled: true,
            monitorDmEnabled: true,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_100,
            deletedAt,
          },
        ],
      });
    }
    const result = yield* Effect.gen(function* () {
      const service = yield* UserConfigService.make;
      return yield* service.upsertUserPlatformConfig("discord", "monitor-1", {
        checkinDmEnabled: false,
      });
    }).pipe(
      Effect.provide(testZero.layer),
      Effect.provideService(IngressBotClient, {
        listClients: () => Effect.succeed([{ platform: "discord", clientId: "discord-main" }]),
      } as unknown as typeof IngressBotClient.Service),
    );
    return { result, rows: yield* testZero.rows("configUserPlatform") };
  });

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

  layer(StatefulTestZeroLayer)("stateful database", (it) => {
    it.effect("persists partial preference updates through read, mutate, and read", () =>
      Effect.gen(function* () {
        const testZero = yield* StatefulTestZero;
        const outcome = yield* runStatefulPartialCheckinUpdate(testZero, null);
        expect(outcome.result).toMatchObject({
          userId: "monitor-1",
          checkinDmEnabled: false,
          monitorDmEnabled: false,
        });
        expect(outcome.rows).toHaveLength(1);
        expect(outcome.rows[0]).toMatchObject({
          userId: "monitor-1",
          checkinDmEnabled: false,
          monitorDmEnabled: false,
          defaultClientId: null,
          deletedAt: null,
        });
      }),
    );

    it.effect("treats soft-deleted preferences as absent for partial updates", () =>
      Effect.gen(function* () {
        const testZero = yield* StatefulTestZero;
        const outcome = yield* runStatefulPartialCheckinUpdate(
          testZero,
          DateTime.toEpochMillis(DateTime.makeUnsafe("2026-07-14T00:00:00.000Z")),
        );
        expect(outcome.result.userId).toBe("monitor-1");
        expect(outcome.result.checkinDmEnabled).toBe(false);
        expect(outcome.result.monitorDmEnabled).toBe(false);
        expect(outcome.rows).toHaveLength(1);
        expect(outcome.rows[0]?.userId).toBe("monitor-1");
        expect(outcome.rows[0]?.defaultClientId).toBe("discord-main");
        expect(outcome.rows[0]?.checkinDmEnabled).toBe(false);
        expect(outcome.rows[0]?.monitorDmEnabled).toBe(false);
        expect(outcome.rows[0]?.deletedAt).toBeNull();
      }),
    );
  });
});
