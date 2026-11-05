import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Stream } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient, Statement } from "effect/unstable/sql";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { browserRunnerCapabilityGroup } from "./browserRunnerCapability";
import { isBrowserRunnerFleetReady } from "./clusterReadiness";

type ReadinessRunner = {
  readonly address: string;
  readonly healthy: boolean;
  readonly heartbeatAgeSeconds: number;
};

type ReadinessLock = {
  readonly address: string;
  readonly shardId: string;
  readonly acquiredAgeSeconds: number;
};

const browserReadinessSql = (
  runners: ReadonlyArray<ReadinessRunner>,
  locks: ReadonlyArray<ReadinessLock>,
  queries: string[],
  parameterSets: unknown[][],
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const execute = (query: string, parameters: ReadonlyArray<unknown>) => {
        queries.push(query);
        parameterSets.push([...parameters]);

        const healthyRunnerFence = query.includes("runner.healthy = TRUE");
        const freshRunnerFence = query.includes("runner.last_heartbeat > NOW()");
        const runnerAddressFence = query.includes(
          '"sheet_workflows_locks".address = runner.address',
        );
        const freshLockFence = query.includes('"sheet_workflows_locks".acquired_at > NOW()');
        const browserGroupFence = query.includes('"sheet_workflows_locks".shard_id LIKE ?');
        const heartbeatWindowSeconds = parameters.find(
          (parameter): parameter is number => typeof parameter === "number" && parameter === 35,
        );
        const lockWindowSeconds = parameters
          .filter((parameter): parameter is number => typeof parameter === "number")
          .at(-2);
        const requiredLockCount = parameters.at(-1);
        const browserGroupPattern = browserGroupFence
          ? parameters.find(
              (parameter): parameter is string =>
                typeof parameter === "string" && parameter.endsWith(":%"),
            )
          : undefined;

        const ready = runners.some((runner) => {
          if (healthyRunnerFence && !runner.healthy) return false;
          if (
            freshRunnerFence &&
            (heartbeatWindowSeconds === undefined ||
              runner.heartbeatAgeSeconds >= heartbeatWindowSeconds)
          )
            return false;

          const heldLocks = locks.filter((lock) => {
            if (runnerAddressFence && lock.address !== runner.address) return false;
            if (
              freshLockFence &&
              (lockWindowSeconds === undefined || lock.acquiredAgeSeconds >= lockWindowSeconds)
            )
              return false;
            if (browserGroupFence) {
              if (browserGroupPattern === undefined) return false;
              if (!lock.shardId.startsWith(browserGroupPattern.slice(0, -1))) return false;
            }
            return true;
          });

          return typeof requiredLockCount === "number" && heldLocks.length === requiredLockCount;
        });

        return Effect.succeed([{ ready }]);
      };

      const connection: Connection = {
        execute,
        executeRaw: () => Effect.succeed(undefined),
        executeStream: () => Stream.empty,
        executeValues: () => Effect.succeed([]),
        executeUnprepared: execute,
      };

      return yield* SqlClient.make({
        acquirer: Effect.succeed(connection),
        compiler: Statement.makeCompilerSqlite(),
        spanAttributes: [],
      });
    }),
  ).pipe(Effect.provide(Reactivity.layer));

describe("browser runner cluster readiness", () => {
  it.effect("requires a healthy runner holding exactly the fresh browser shard group", () =>
    Effect.gen(function* () {
      const queries: string[] = [];
      const parameterSets: unknown[][] = [];
      const browserCapabilityGroup = yield* browserRunnerCapabilityGroup;
      const browserRunner: ReadinessRunner = {
        address: "10.0.0.12:34431",
        healthy: true,
        heartbeatAgeSeconds: 1,
      };
      const rowsFor = (
        group: string,
        count: number,
        ageSeconds = 1,
      ): ReadonlyArray<ReadinessLock> =>
        Array.from({ length: count }, (_, shard) => ({
          address: browserRunner.address,
          shardId: `${group}:${shard}`,
          acquiredAgeSeconds: ageSeconds,
        }));
      const cases: ReadonlyArray<{
        readonly label: string;
        readonly runners: ReadonlyArray<ReadinessRunner>;
        readonly locks: ReadonlyArray<ReadinessLock>;
        readonly expected: boolean;
      }> = [
        {
          label: "owned browser capability group",
          runners: [browserRunner],
          locks: rowsFor(browserCapabilityGroup, 300),
          expected: true,
        },
        {
          label: "legacy browser action group without current compatibility binding",
          runners: [browserRunner],
          locks: rowsFor("browser", 300),
          expected: false,
        },
        {
          label: "300 locks held under a mismatched browser capability identity",
          runners: [browserRunner],
          locks: rowsFor(`browser-capability-v1-${"a".repeat(64)}`, 300),
          expected: false,
        },
        {
          label: "ordinary-only group",
          runners: [browserRunner],
          locks: rowsFor("dispatch", 300),
          expected: false,
        },
        {
          label: "mixed browser and ordinary groups",
          runners: [browserRunner],
          locks: [...rowsFor(browserCapabilityGroup, 150), ...rowsFor("dispatch", 150)],
          expected: false,
        },
        {
          label: "another shard group",
          runners: [browserRunner],
          locks: rowsFor("autoCheckin", 300),
          expected: false,
        },
        {
          label: "stale browser capability locks",
          runners: [browserRunner],
          locks: rowsFor(browserCapabilityGroup, 300, 36),
          expected: false,
        },
        {
          label: "stale browser capability runner heartbeat",
          runners: [{ ...browserRunner, heartbeatAgeSeconds: 36 }],
          locks: rowsFor(browserCapabilityGroup, 300),
          expected: false,
        },
        {
          label: "unhealthy browser capability runner",
          runners: [{ ...browserRunner, healthy: false }],
          locks: rowsFor(browserCapabilityGroup, 300),
          expected: false,
        },
      ];

      for (const scenario of cases) {
        const sql = yield* browserReadinessSql(
          scenario.runners,
          scenario.locks,
          queries,
          parameterSets,
        );
        const ready = yield* isBrowserRunnerFleetReady.pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        expect(ready, scenario.label).toBe(scenario.expected);
      }

      expect(queries[0]).toContain('FROM "sheet_workflows_runners" AS runner');
      expect(queries[0]).toContain('"sheet_workflows_locks".address = runner.address');
      expect(queries[0]).toContain('"sheet_workflows_locks".shard_id LIKE ?');
      expect(parameterSets[0]).toContain(`${browserCapabilityGroup}:%`);
      expect(parameterSets[0]).toContain(300);
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            POSTGRES_URL: "postgres://workflows:test@127.0.0.1:5432/workflows",
          }),
        ),
      ),
    ),
  );
});
