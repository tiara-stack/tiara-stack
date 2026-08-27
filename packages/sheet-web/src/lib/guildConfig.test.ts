import { Cause, HashSet, Option } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vitest";
import {
  buildChannelLabels,
  channelConfigPatch,
  channelDraftFrom,
  guildCapabilities,
  permissionsFromResult,
  serverConfigFormFrom,
  serverConfigPatch,
  sortGuildChannels,
  sortGuildRoles,
  type Permission,
  type PermissionSet,
} from "./guildConfig";

const timestamps = {
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
};

describe("guild configuration helpers", () => {
  it("distinguishes member, monitor, manager, and app-owner capabilities", () => {
    const permissions = (...values: ReadonlyArray<Permission>) => HashSet.fromIterable(values);

    expect(guildCapabilities(permissions("member_workspace:guild-1"), "guild-1")).toEqual({
      canManage: false,
      canLockdown: false,
    });
    expect(guildCapabilities(permissions("monitor_workspace:guild-1"), "guild-1")).toEqual({
      canManage: false,
      canLockdown: true,
    });
    expect(guildCapabilities(permissions("manage_workspace:guild-1"), "guild-1")).toEqual({
      canManage: true,
      canLockdown: true,
    });
    expect(guildCapabilities(permissions("app_owner"), "guild-1")).toEqual({
      canManage: true,
      canLockdown: true,
    });
    expect(guildCapabilities(permissions("service"), "guild-1")).toEqual({
      canManage: true,
      canLockdown: true,
    });
    expect(guildCapabilities(permissions("manage_workspace:guild-2"), "guild-1")).toEqual({
      canManage: false,
      canLockdown: false,
    });
  });

  it("uses current, previous, or empty permissions from resource results", () => {
    const currentPermissions = HashSet.fromIterable<Permission>(["manage_workspace:guild-1"]);
    const previousPermissions = HashSet.fromIterable<Permission>(["monitor_workspace:guild-1"]);
    const previousSuccess = AsyncResult.success({ permissions: previousPermissions });

    expect(permissionsFromResult(AsyncResult.success({ permissions: currentPermissions }))).toEqual(
      currentPermissions,
    );
    expect(
      permissionsFromResult(
        AsyncResult.failure(Cause.empty, {
          previousSuccess: Option.some(previousSuccess),
        }),
      ),
    ).toEqual(previousPermissions);
    expect(
      permissionsFromResult(
        AsyncResult.failure<{ readonly permissions: PermissionSet }>(Cause.empty),
      ),
    ).toEqual(HashSet.empty());
  });

  it("omits unchanged server fields and encodes monitor-channel clearing as null", () => {
    const config = {
      workspaceId: "guild-1",
      sheetId: "sheet-1",
      autoCheckin: true,
      monitorConversationId: "channel-1",
      ...timestamps,
    };
    expect(serverConfigPatch(config, serverConfigFormFrom(config))).toEqual({});
    expect(
      serverConfigPatch(config, {
        ...serverConfigFormFrom(config),
        monitorConversationId: "",
      }),
    ).toEqual({ monitorConversationId: null });
    expect(
      serverConfigPatch(config, {
        ...serverConfigFormFrom(config),
        monitorConversationId: "   ",
      }),
    ).toEqual({ monitorConversationId: null });
    expect(
      serverConfigPatch(config, {
        ...serverConfigFormFrom(config),
        sheetId: "",
      }),
    ).toEqual({});
    expect(
      serverConfigPatch(config, {
        ...serverConfigFormFrom(config),
        sheetId: "  sheet-2  ",
      }),
    ).toEqual({ sheetId: "sheet-2" });
    expect(
      serverConfigPatch(config, {
        ...serverConfigFormFrom(config),
        autoCheckin: false,
      }),
    ).toEqual({ autoCheckin: false });
  });

  it("preserves omitted channel fields and encodes explicit clears as null", () => {
    const config = {
      workspaceId: "guild-1",
      conversationId: "channel-1",
      name: "room-one",
      running: true,
      roleId: "missing-role",
      checkinConversationId: "missing-channel",
      ...timestamps,
    };
    expect(channelConfigPatch(config, channelDraftFrom(config))).toEqual({});
    expect(
      channelConfigPatch(config, {
        ...channelDraftFrom(config),
        roleId: "",
        checkinConversationId: "",
      }),
    ).toEqual({
      roleId: null,
      checkinConversationId: null,
    });
    expect(
      channelConfigPatch(config, {
        ...channelDraftFrom(config),
        running: "disabled",
      }),
    ).toEqual({ running: false });
  });

  it("does not create an unconfigured channel without a field value", () => {
    expect(channelConfigPatch(undefined, channelDraftFrom(undefined))).toEqual({});
  });

  it("treats blank configured logical names as unset", () => {
    const config = {
      workspaceId: "guild-1",
      conversationId: "channel-1",
      name: "room-one",
      running: null,
      roleId: null,
      checkinConversationId: null,
      ...timestamps,
    };

    expect(
      channelConfigPatch(config, {
        ...channelDraftFrom(config),
        name: "   ",
      }),
    ).toEqual({ name: null });
    expect(
      channelConfigPatch(config, {
        ...channelDraftFrom(config),
        name: "  room  ",
      }),
    ).toEqual({ name: "room" });
  });

  it("disambiguates duplicate channel names with category or ID context", () => {
    const channels = [
      { id: "category-1", name: "Raids", type: 4, parentId: null, position: 0 },
      { id: "channel-1001", name: "general", type: 0, parentId: "category-1", position: 1 },
      { id: "channel-2002", name: "general", type: 0, parentId: null, position: 2 },
    ];

    expect(buildChannelLabels(channels)).toEqual(
      new Map([
        ["category-1", "Raids"],
        ["channel-1001", "general · Raids"],
        ["channel-2002", "general · 2002"],
      ]),
    );
  });

  it("adds channel IDs when duplicate names share a category", () => {
    const channels = [
      { id: "category-1", name: "Raids", type: 4, parentId: null, position: 0 },
      { id: "channel-1001", name: "general", type: 0, parentId: "category-1", position: 1 },
      { id: "channel-2002", name: "general", type: 0, parentId: "category-1", position: 2 },
    ];

    expect(buildChannelLabels(channels)).toEqual(
      new Map([
        ["category-1", "Raids"],
        ["channel-1001", "general · Raids · channel-1001"],
        ["channel-2002", "general · Raids · channel-2002"],
      ]),
    );
  });

  it("counts category and non-category names separately", () => {
    const channels = [
      { id: "category-1", name: "general", type: 4, parentId: null, position: 0 },
      { id: "channel-1001", name: "general", type: 0, parentId: "category-1", position: 1 },
    ];

    expect(buildChannelLabels(channels)).toEqual(
      new Map([
        ["category-1", "general"],
        ["channel-1001", "general"],
      ]),
    );
  });

  it("sorts channels ascending and roles descending by position", () => {
    const channels = [
      { id: "channel-2", name: "second", type: 0, parentId: null, position: 2 },
      { id: "channel-1", name: "first", type: 0, parentId: null, position: 1 },
    ];
    const roles = [
      { id: "role-1", name: "lower", position: 1, color: 0, managed: false },
      { id: "role-2", name: "higher", position: 2, color: 0, managed: false },
    ];

    expect(sortGuildChannels(channels).map(({ id }) => id)).toEqual(["channel-1", "channel-2"]);
    expect(sortGuildRoles(roles).map(({ id }) => id)).toEqual(["role-2", "role-1"]);
  });
});
