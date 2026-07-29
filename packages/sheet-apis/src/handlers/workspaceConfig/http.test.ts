import { describe, expect, it } from "@effect/vitest";
import {
  type ChannelPermissionOverwrite,
  DiscordBotUpstreamError,
} from "dfx-discord-utils/discord/schema";
import { Cause, Effect, Exit, Option } from "effect";
import {
  WorkspaceConversationConfig,
  WorkspaceMonitorRole,
} from "sheet-ingress-api/schemas/workspaceConfig";
import { setupWorkspaceConversationLockdown, undoWorkspaceConversationLockdown } from "./http";

const payload = {
  workspaceId: "guild-1",
  conversationId: "channel-1",
};

const timestamps = {
  createdAt: Option.none(),
  updatedAt: Option.none(),
  deletedAt: Option.none(),
};

const conversationConfig = (roleId: Option.Option<string>) =>
  new WorkspaceConversationConfig({
    workspaceId: payload.workspaceId,
    conversationId: payload.conversationId,
    name: Option.some("running-room"),
    running: Option.some(true),
    roleId,
    checkinConversationId: Option.none(),
    ...timestamps,
  });

const makeWorkspaceConfigService = (
  config: Option.Option<WorkspaceConversationConfig>,
  monitorRoleIds: ReadonlyArray<string> = ["role-monitor"],
) => ({
  getWorkspaceConversationById: () => Effect.succeed(config),
  getWorkspaceMonitorRoles: () =>
    Effect.succeed(
      monitorRoleIds.map(
        (roleId) =>
          new WorkspaceMonitorRole({
            workspaceId: payload.workspaceId,
            roleId,
            ...timestamps,
          }),
      ),
    ),
});

const guildChannels = [
  {
    id: payload.conversationId,
    name: "running-room",
    type: 0,
    parentId: null,
    position: 1,
  },
];

const squashFailure = <A, E>(exit: Exit.Exit<A, E>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) {
    throw new Error("Expected the Effect to fail");
  }
  expect(Cause.hasFails(exit.cause)).toBe(true);
  return Cause.squash(exit.cause);
};

describe("workspace configuration lockdown handlers", () => {
  it.effect("replaces permission overwrites and returns identifiers for setup", () =>
    Effect.gen(function* () {
      const replacements: Array<{
        readonly channelId: string;
        readonly overwrites: ReadonlyArray<typeof ChannelPermissionOverwrite.Type>;
      }> = [];
      const ingressBotClient = {
        getGuildChannels: () => Effect.succeed(guildChannels),
        replaceChannelPermissionOverwrites: (
          channelId: string,
          overwrites: ReadonlyArray<typeof ChannelPermissionOverwrite.Type>,
        ) =>
          Effect.sync(() => {
            replacements.push({ channelId, overwrites });
          }).pipe(Effect.as({})),
      };

      const result = yield* setupWorkspaceConversationLockdown(
        payload,
        makeWorkspaceConfigService(Option.some(conversationConfig(Option.some("role-lockdown")))),
        ingressBotClient,
      );

      expect(result).toEqual(payload);
      expect(replacements).toEqual([
        {
          channelId: payload.conversationId,
          overwrites: [
            {
              id: "role-lockdown",
              type: 0,
              allow: "330752",
              deny: "0",
            },
            {
              id: "role-monitor",
              type: 0,
              allow: "2251799814016016",
              deny: "0",
            },
            {
              id: payload.workspaceId,
              type: 0,
              allow: "0",
              deny: "1024",
            },
          ],
        },
      ]);
    }),
  );

  it.effect("rejects setup when the channel configuration is missing", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        setupWorkspaceConversationLockdown(payload, makeWorkspaceConfigService(Option.none()), {
          getGuildChannels: () => Effect.succeed(guildChannels),
          replaceChannelPermissionOverwrites: () => Effect.succeed({}),
        }),
      );

      expect(squashFailure(exit)).toMatchObject({
        message: expect.stringContaining("is not configured"),
      });
    }),
  );

  it.effect("rejects setup when the lockdown role is missing", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        setupWorkspaceConversationLockdown(
          payload,
          makeWorkspaceConfigService(Option.some(conversationConfig(Option.none()))),
          {
            getGuildChannels: () => Effect.succeed(guildChannels),
            replaceChannelPermissionOverwrites: () => Effect.succeed({}),
          },
        ),
      );

      expect(squashFailure(exit)).toMatchObject({
        message: expect.stringContaining("has no lockdown role"),
      });
    }),
  );

  it.effect("rejects setup when @everyone is configured as the lockdown role", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        setupWorkspaceConversationLockdown(
          payload,
          {
            ...makeWorkspaceConfigService(
              Option.some(conversationConfig(Option.some(payload.workspaceId))),
            ),
            getWorkspaceMonitorRoles: () =>
              Effect.die("monitor roles must not load for an invalid lockdown role"),
          },
          {
            getGuildChannels: () => Effect.succeed(guildChannels),
            replaceChannelPermissionOverwrites: () => Effect.succeed({}),
          },
        ),
      );

      expect(squashFailure(exit)).toMatchObject({
        message: "The @everyone role cannot be used as the lockdown role",
      });
    }),
  );

  it.effect("rejects setup when the channel is outside the workspace", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        setupWorkspaceConversationLockdown(
          payload,
          {
            ...makeWorkspaceConfigService(
              Option.some(conversationConfig(Option.some("role-lockdown"))),
            ),
            getWorkspaceMonitorRoles: () =>
              Effect.die("monitor roles must not load for a channel outside the workspace"),
          },
          {
            getGuildChannels: () => Effect.succeed([]),
            replaceChannelPermissionOverwrites: () => Effect.succeed({}),
          },
        ),
      );

      expect(squashFailure(exit)).toMatchObject({
        message: expect.stringContaining("is not in workspace"),
      });
    }),
  );

  it.effect("propagates Discord replacement failures during setup", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        setupWorkspaceConversationLockdown(
          payload,
          makeWorkspaceConfigService(Option.some(conversationConfig(Option.some("role-lockdown")))),
          {
            getGuildChannels: () => Effect.succeed(guildChannels),
            replaceChannelPermissionOverwrites: () =>
              Effect.fail(new DiscordBotUpstreamError({ message: "Discord unavailable" })),
          },
        ),
      );

      expect(squashFailure(exit)).toMatchObject({
        _tag: "DiscordBotUpstreamError",
        message: "Discord unavailable",
      });
    }),
  );

  it.effect("clears all overwrites and returns identifiers for undo", () =>
    Effect.gen(function* () {
      const replacements: Array<{
        readonly channelId: string;
        readonly overwrites: ReadonlyArray<typeof ChannelPermissionOverwrite.Type>;
      }> = [];
      const result = yield* undoWorkspaceConversationLockdown(payload, {
        getGuildChannels: () => Effect.succeed(guildChannels),
        replaceChannelPermissionOverwrites: (channelId, overwrites) =>
          Effect.sync(() => {
            replacements.push({ channelId, overwrites });
          }).pipe(Effect.as({})),
      });

      expect(result).toEqual(payload);
      expect(replacements).toEqual([{ channelId: payload.conversationId, overwrites: [] }]);
    }),
  );

  it.effect("rejects undo when the channel is outside the workspace", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        undoWorkspaceConversationLockdown(payload, {
          getGuildChannels: () => Effect.succeed([]),
          replaceChannelPermissionOverwrites: () => Effect.succeed({}),
        }),
      );

      expect(squashFailure(exit)).toMatchObject({
        message: expect.stringContaining("is not in workspace"),
      });
    }),
  );

  it.effect("propagates Discord replacement failures without reporting success", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        undoWorkspaceConversationLockdown(payload, {
          getGuildChannels: () => Effect.succeed(guildChannels),
          replaceChannelPermissionOverwrites: () =>
            Effect.fail(new DiscordBotUpstreamError({ message: "Discord unavailable" })),
        }),
      );

      expect(squashFailure(exit)).toMatchObject({
        _tag: "DiscordBotUpstreamError",
        message: "Discord unavailable",
      });
    }),
  );
});
