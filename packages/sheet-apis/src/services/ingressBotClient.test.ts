import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { makeGuildResourceOperations } from "./ingressBotClient";

const makeClient = ({
  channels = [],
  roles = [],
  replace = () => Effect.succeed({ updated: true }),
}: {
  readonly channels?: ReadonlyArray<{ readonly resourceId: string; readonly value: unknown }>;
  readonly roles?: ReadonlyArray<{ readonly resourceId: string; readonly value: unknown }>;
  readonly replace?: (request: {
    readonly params: { readonly channelId: string };
    readonly payload: {
      readonly permissionOverwrites: ReadonlyArray<{
        readonly id: string;
        readonly type: 0 | 1;
        readonly allow: string;
        readonly deny: string;
      }>;
    };
  }) => Effect.Effect<{ readonly updated: boolean }>;
}) => ({
  cache: {
    getChannelsForParent: () => Effect.succeed(channels),
    getRolesForParent: () => Effect.succeed(roles),
  },
  bot: {
    replaceChannelPermissionOverwrites: replace,
  },
});

const squashFailure = <A, E>(exit: Exit.Exit<A, E>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) {
    throw new Error("Expected the Effect to fail");
  }
  return Cause.squash(exit.cause);
};

describe("guild resource ingress bot operations", () => {
  it.effect("maps complete channel and role cache records", () =>
    Effect.gen(function* () {
      const operations = makeGuildResourceOperations(
        makeClient({
          channels: [
            {
              resourceId: "channel-1",
              value: {
                name: "general",
                type: 0,
                parent_id: "category-1",
                position: 2,
              },
            },
            {
              resourceId: "channel-2",
              value: {
                name: "announcements",
                type: 5,
                position: 3,
              },
            },
          ],
          roles: [
            {
              resourceId: "role-1",
              value: {
                name: "Monitor",
                position: 4,
                color: 0xff_aa_00,
                managed: false,
              },
            },
          ],
        }),
      );

      expect(yield* operations.getGuildChannels("guild-1")).toEqual([
        {
          id: "channel-1",
          name: "general",
          type: 0,
          parentId: "category-1",
          position: 2,
        },
        {
          id: "channel-2",
          name: "announcements",
          type: 5,
          parentId: null,
          position: 3,
        },
      ]);
      expect(yield* operations.getGuildRoles("guild-1")).toEqual([
        {
          id: "role-1",
          name: "Monitor",
          position: 4,
          color: 0xff_aa_00,
          managed: false,
        },
      ]);
    }),
  );

  it.effect("rejects an entire channel list when one cache record is invalid", () =>
    Effect.gen(function* () {
      const operations = makeGuildResourceOperations(
        makeClient({
          channels: [
            {
              resourceId: "channel-1",
              value: { name: "general", type: 0, position: 1 },
            },
            {
              resourceId: "channel-2",
              value: { name: "missing-position", type: 0 },
            },
          ],
        }),
      );

      const exit = yield* Effect.exit(operations.getGuildChannels("guild-1"));
      expect(squashFailure(exit)).toMatchObject({
        _tag: "ArgumentError",
        message: "Invalid guild channel data returned by the Discord cache",
      });
    }),
  );

  it.effect("rejects an entire role list when one cache record is invalid", () =>
    Effect.gen(function* () {
      const operations = makeGuildResourceOperations(
        makeClient({
          roles: [
            {
              resourceId: "role-1",
              value: { name: "Monitor", position: 1, color: 0, managed: false },
            },
            {
              resourceId: "role-2",
              value: { name: "Incomplete", position: 2, color: 0 },
            },
          ],
        }),
      );

      const exit = yield* Effect.exit(operations.getGuildRoles("guild-1"));
      expect(squashFailure(exit)).toMatchObject({
        _tag: "ArgumentError",
        message: "Invalid guild role data returned by the Discord cache",
      });
    }),
  );

  it.effect("forwards complete permission overwrite replacements", () =>
    Effect.gen(function* () {
      const requests: Array<unknown> = [];
      const operations = makeGuildResourceOperations(
        makeClient({
          replace: (request) =>
            Effect.sync(() => {
              requests.push(request);
              return { updated: true };
            }),
        }),
      );
      const overwrites = [
        {
          id: "role-1",
          type: 0 as const,
          allow: "1024",
          deny: "0",
        },
      ];

      expect(yield* operations.replaceChannelPermissionOverwrites("channel-1", overwrites)).toEqual(
        {
          updated: true,
        },
      );
      expect(requests).toEqual([
        {
          params: { channelId: "channel-1" },
          payload: { permissionOverwrites: overwrites },
        },
      ]);
    }),
  );
});
