import { describe, expect, it, layer } from "@effect/vitest";
import { Cause, Context, DateTime, Duration, Effect, Exit, Layer, Option, Predicate } from "effect";
import { ArgumentError } from "typhoon-core/error";
import { UserPlatformConfig } from "sheet-ingress-api/schemas/userConfig";
import { makeTestSheetZeroClient, type TestSheetZero } from "../testdb";
import { IngressBotClient } from "./ingressBotClient";
import { SheetZeroClient, type SheetZeroClientApi } from "./sheetZeroClient";
import { UserConfigService } from "./userConfig";

type PartialSheetZeroClient = {
  readonly [Group in keyof SheetZeroClientApi]?: Partial<SheetZeroClientApi[Group]>;
};

const makePartialService = <Service extends object>(
  name: string,
  overrides: Partial<Service>,
): Service =>
  new Proxy(overrides, {
    get: (target, property, receiver) => {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      const die = () => Effect.die(new Error(`Unexpected ${name}.${String(property)} call`));
      return Object.assign(die, { mutate: die });
    },
  }) as Service;

const makeSheetZeroClient = (overrides: PartialSheetZeroClient): SheetZeroClientApi => ({
  userConfig: makePartialService("SheetZeroClient.userConfig", overrides.userConfig ?? {}),
  workspaceConfig: makePartialService(
    "SheetZeroClient.workspaceConfig",
    overrides.workspaceConfig ?? {},
  ),
  messageCheckin: makePartialService(
    "SheetZeroClient.messageCheckin",
    overrides.messageCheckin ?? {},
  ),
  messageRoomOrder: makePartialService(
    "SheetZeroClient.messageRoomOrder",
    overrides.messageRoomOrder ?? {},
  ),
  messageSlot: makePartialService("SheetZeroClient.messageSlot", overrides.messageSlot ?? {}),
  messageTeamSubmission: makePartialService(
    "SheetZeroClient.messageTeamSubmission",
    overrides.messageTeamSubmission ?? {},
  ),
});

const makeIngressBotClient = (
  overrides: Partial<typeof IngressBotClient.Service> = {},
): typeof IngressBotClient.Service =>
  makePartialService("IngressBotClient", {
    listClients: () => Effect.succeed([]),
    ...overrides,
  });

type UpsertUserPlatformConfig = SheetZeroClientApi["userConfig"]["upsertUserPlatformConfig"];
type UpsertUserPlatformConfigArgs = Parameters<UpsertUserPlatformConfig>;

const makeUpsertUserPlatformConfig = (
  server: (...args: UpsertUserPlatformConfigArgs) => ReturnType<UpsertUserPlatformConfig>,
): UpsertUserPlatformConfig =>
  Object.assign(server, {
    mutate: (...args: UpsertUserPlatformConfigArgs) =>
      Effect.succeed({
        client: () => Effect.void,
        server: () => server(...args),
      }),
  });

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
    readonly zero: PartialSheetZeroClient;
    readonly ingressBotClient?: Partial<typeof IngressBotClient.Service>;
  },
) =>
  Effect.gen(function* () {
    const service = yield* UserConfigService.make;
    return yield* effect(service);
  }).pipe(
    Effect.provideService(SheetZeroClient, makeSheetZeroClient(options.zero)),
    Effect.provideService(IngressBotClient, makeIngressBotClient(options.ingressBotClient)),
  );

const firstFailure = <E>(exit: Exit.Exit<unknown, E>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

const StatefulTestZero = Context.Service<TestSheetZero>("StatefulTestZero");
const StatefulTestZeroLayer = Layer.effect(StatefulTestZero, makeTestSheetZeroClient());
const withStatefulTestZero = layer(StatefulTestZeroLayer, {
  timeout: Duration.seconds(30),
});

const runStatefulPartialCheckinUpdate = (
  testZero: TestSheetZero,
  deletedAt: number | null | undefined,
) =>
  Effect.gen(function* () {
    yield* testZero.reset;
    if (!Predicate.isUndefined(deletedAt)) {
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
      Effect.provideService(
        IngressBotClient,
        makeIngressBotClient({
          listClients: () => Effect.succeed([{ platform: "discord", clientId: "discord-main" }]),
        }),
      ),
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
                upsertUserPlatformConfig: makeUpsertUserPlatformConfig((args) =>
                  Effect.sync(() => {
                    mutationCalls.push(args);
                  }),
                ),
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

  withStatefulTestZero("stateful database", (it) => {
    it.effect("persists partial preference updates through read, mutate, and read", () =>
      Effect.gen(function* () {
        const testZero = yield* StatefulTestZero;
        const outcome = yield* runStatefulPartialCheckinUpdate(testZero, null);
        expect(outcome.result).toMatchObject({
          userId: "monitor-1",
          checkinDmEnabled: false,
          monitorDmEnabled: true,
        });
        expect(outcome.rows).toHaveLength(1);
        expect(outcome.rows[0]).toMatchObject({
          userId: "monitor-1",
          checkinDmEnabled: false,
          monitorDmEnabled: true,
          defaultClientId: "discord-main",
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
