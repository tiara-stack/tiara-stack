import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { MutateRequest, Transaction } from "@rocicorp/zero";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { ZeroApiClient } from "typhoon-zero/zeroApi";
import { configUserPlatform, messageCheckin, messageRoomOrder } from "./models";
import {
  canonicalSnapshot,
  ddlParityShape,
  makeCanonicalDdl,
  makeTestSheetZeroDatabase,
  testDdlIntentionalDifferences,
} from "./testdb";
import { SheetZeroApi } from "./zero/api";
import { mutators } from "./zero/mutators";
import { builder, type Schema as SheetZeroSchema } from "./zero/schema";

const userOptionSchema = Schema.toType(Schema.OptionFromNullishOr(configUserPlatform.json));
const usersSchema = Schema.Array(configUserPlatform.json);
const checkinOptionSchema = Schema.toType(Schema.OptionFromNullishOr(messageCheckin.json));
const roomOrderOptionSchema = Schema.toType(Schema.OptionFromNullishOr(messageRoomOrder.json));

const userRow = {
  platform: "discord",
  userId: "user-1",
  defaultClientId: "client-1",
  checkinDmEnabled: false,
  monitorDmEnabled: true,
  createdAt: 1_700_000_000_123,
  updatedAt: 1_700_000_000_456,
  deletedAt: null,
} as const;

const messageKey = {
  clientPlatform: "discord",
  clientId: "client-1",
  messageId: "message-1",
} as const;

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("PGlite Sheet Zero contract", () => {
  it("renders defaults, uniqueness, references, and reference actions from snapshots", () => {
    const statements = makeCanonicalDdl({
      version: 1,
      dialect: "postgresql",
      tables: {
        parent: {
          name: "parent",
          columns: {
            id: {
              fieldName: "id",
              name: "id",
              kind: "integer",
              notNull: true,
              primaryKey: true,
              defaultSql: "nextval('parent_id_seq')",
            },
          },
          primaryKey: ["id"],
          indexes: [],
        },
        child: {
          name: "child",
          columns: {
            parentId: {
              fieldName: "parentId",
              name: "parent_id",
              kind: "integer",
              notNull: true,
              primaryKey: false,
              unique: "child_parent_unique",
              default: 1,
              references: {
                table: "parent",
                column: "id",
                onDelete: "cascade",
                onUpdate: "restrict",
              },
            },
          },
          primaryKey: [],
          indexes: [],
        },
      },
    });

    expect(statements[0]).toContain("default nextval('parent_id_seq')");
    expect(statements[1]).toContain('constraint "child_parent_unique" unique');
    expect(statements[1]).toContain("default 1");
    expect(statements[2]).toContain('references "parent" ("id")');
    expect(statements[2]).toContain("on delete cascade on update restrict");
  });

  it.live("keeps canonical test DDL structurally aligned with the latest migration snapshot", () =>
    Effect.gen(function* () {
      const metadataDirectory = new URL("../effect-sql-migrations/meta/", import.meta.url);
      const latestSnapshot = (yield* Effect.promise(() => readdir(metadataDirectory)))
        .filter((name) => name.endsWith("_snapshot.json"))
        .sort()
        .at(-1);
      if (!latestSnapshot) throw new Error("No stored sheet-db-schema migration snapshot found");
      const stored = yield* Effect.promise(() =>
        readFile(new URL(latestSnapshot, metadataDirectory), "utf8"),
      );
      const migration = JSON.parse(stored) as {
        readonly schema: ReturnType<typeof canonicalSnapshot>;
      };
      const canonicalShape = ddlParityShape(canonicalSnapshot());
      const migrationShape = ddlParityShape(migration.schema);

      expect(hash(canonicalShape)).toBe(hash(migrationShape));
      expect(canonicalShape).toEqual(migrationShape);
      expect(testDdlIntentionalDifferences).toEqual([
        expect.stringContaining("publication"),
        expect.stringContaining("CHECK"),
        expect.stringContaining("Partial-index"),
      ]);
      expect(makeCanonicalDdl().some((statement) => /publication/i.test(statement))).toBe(false);
    }),
  );

  it.live("executes the Zero 0.25 server-adapter contract in one scoped database", () =>
    Effect.gen(function* () {
      const database = yield* makeTestSheetZeroDatabase({ measureTimings: true });
      const client = yield* ZeroApiClient.makeWithService(SheetZeroApi, database.executor, {
        mutators,
      });

      expect(database.timings.startupMs).toBeGreaterThan(0);
      expect(database.timings.bootstrapMs).toBeGreaterThan(0);
      expect(database.timings.truncateResetMs).toBeGreaterThan(0);
      expect(database.timings.rollbackRoundTripMs).toBeGreaterThan(0);
      console.info("PGlite reusable test database timing", database.timings);

      yield* database.seed({
        configUserPlatform: [
          userRow,
          { ...userRow, userId: "user-2", defaultClientId: null, monitorDmEnabled: false },
          { ...userRow, userId: "user-3", defaultClientId: "client-3" },
        ],
      });

      // Query contract: =, IN, IS, IS NOT, one(), and orderBy.
      const one = yield* database.executor.run(
        builder.configUserPlatform.where("userId", "=", "user-1").one(),
      );
      expect(one?.userId).toBe("user-1");
      const inRows = yield* database.executor.run(
        builder.configUserPlatform.where("userId", "IN", ["user-1", "user-3"]),
      );
      expect(inRows).toHaveLength(2);
      const nullRows = yield* database.executor.run(
        builder.configUserPlatform.where("defaultClientId", "IS", null),
      );
      expect(nullRows.map(({ userId }) => userId)).toEqual(["user-2"]);
      const nonNullRows = yield* database.executor.run(
        builder.configUserPlatform
          .where("defaultClientId", "IS NOT", null)
          .orderBy("userId", "desc"),
      );
      expect(nonNullRows.map(({ userId }) => userId)).toEqual(["user-3", "user-1"]);

      // Endpoint success decoding and compound-key upsert/read-after-write.
      const decodedSeed = Option.getOrThrow(
        yield* Schema.decodeUnknownEffect(userOptionSchema)(
          yield* client.userConfig.getUserPlatformConfig({
            platform: "discord",
            userId: "user-1",
          }),
        ),
      );
      expect(decodedSeed).toEqual(userRow);
      yield* client.userConfig.upsertUserPlatformConfig({
        platform: "discord",
        userId: "user-1",
        checkinDmEnabled: true,
      });
      const upserted = Option.getOrThrow(
        yield* Schema.decodeUnknownEffect(userOptionSchema)(
          yield* client.userConfig.getUserPlatformConfig({
            platform: "discord",
            userId: "user-1",
          }),
        ),
      );
      expect(upserted.checkinDmEnabled).toBe(true);
      expect(yield* database.rows("configUserPlatform")).toHaveLength(3);

      // Insert, update/soft-delete, hard delete during revival, and timestamp stamping.
      yield* client.workspaceConfig.addWorkspaceFeatureFlag({
        workspaceId: "workspace-1",
        flagName: "feature-1",
      });
      const insertedFlag = (yield* database.rows("configWorkspaceFeatureFlag"))[0]!;
      expect(typeof insertedFlag.createdAt).toBe("number");
      expect(typeof insertedFlag.updatedAt).toBe("number");
      yield* client.workspaceConfig.removeWorkspaceFeatureFlag({
        workspaceId: "workspace-1",
        flagName: "feature-1",
      });
      const deletedFlag = (yield* database.rows("configWorkspaceFeatureFlag"))[0]!;
      expect(typeof deletedFlag.deletedAt).toBe("number");
      const activeFlag = yield* client.workspaceConfig.getWorkspaceFeatureFlag({
        workspaceId: "workspace-1",
        flagName: "feature-1",
      });
      expect(Option.isNone(activeFlag as Option.Option<unknown>)).toBe(true);
      yield* client.workspaceConfig.addWorkspaceFeatureFlag({
        workspaceId: "workspace-1",
        flagName: "feature-1",
      });
      expect(yield* database.rows("configWorkspaceFeatureFlag")).toHaveLength(1);
      expect((yield* database.rows("configWorkspaceFeatureFlag"))[0]!.deletedAt).toBeNull();

      // Transaction rollback after a mutator reads but fails validation.
      const invalidExit = yield* Effect.exit(
        client.userConfig.upsertUserPlatformConfig({
          platform: "discord",
          userId: "rollback-user",
          monitorDmEnabled: true,
        }),
      );
      expect(Exit.isFailure(invalidExit)).toBe(true);
      if (Exit.isFailure(invalidExit)) {
        expect(Cause.pretty(invalidExit.cause)).toContain(
          "A default notification client is required to enable DMs",
        );
      }
      expect(
        (yield* database.rows("configUserPlatform")).some(
          ({ userId }) => userId === "rollback-user",
        ),
      ).toBe(false);

      const syntheticRollback = {
        args: {},
        mutator: {
          fn: async ({ tx }: { readonly tx: Transaction<SheetZeroSchema, any> }) => {
            await tx.mutate.configWorkspaceFeatureFlag.insert({
              workspaceId: "rollback-workspace",
              flagName: "rollback-flag",
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_000_000,
              deletedAt: null,
            });
            throw new Error("synthetic rollback after insert");
          },
        },
      } as unknown as MutateRequest<any, SheetZeroSchema, undefined, any>;
      const rollbackPhases = yield* database.executor.mutate(syntheticRollback);
      expect(Exit.isFailure(yield* Effect.exit(rollbackPhases.server()))).toBe(true);
      expect(
        (yield* database.rows("configWorkspaceFeatureFlag")).some(
          ({ workspaceId }) => workspaceId === "rollback-workspace",
        ),
      ).toBe(false);

      // Promise.all-heavy mutations plus jsonb, varchar[], and timestamptz conversions.
      const initialMessage = [{ type: "text", text: "hello" }] as const;
      yield* client.messageCheckin.persistMessageCheckin({
        ...messageKey,
        data: {
          initialMessage,
          hour: 12,
          runningConversationId: "running-1",
          roleId: null,
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          createdByUserId: "author-1",
        },
        memberIds: ["member-1", "member-2", "member-3"],
      });
      const checkin = Option.getOrThrow(
        yield* Schema.decodeUnknownEffect(checkinOptionSchema)(
          yield* client.messageCheckin.getMessageCheckinData(messageKey),
        ),
      );
      expect(checkin.initialMessage).toEqual(initialMessage);
      expect(typeof checkin.createdAt).toBe("number");
      expect(yield* database.rows("messageCheckinMember")).toHaveLength(3);

      yield* client.messageRoomOrder.persistMessageRoomOrder({
        ...messageKey,
        data: {
          previousFills: ["old-a", "old-b"],
          fills: ["new-a", "new-b"],
          hour: 14,
          rank: 2,
          tentative: true,
          monitor: "monitor-1",
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          createdByUserId: "author-1",
        },
        entries: [
          { rank: 2, position: 0, hour: 14, team: "A", tags: ["x"], effectValue: 1.5 },
          { rank: 2, position: 1, hour: 15, team: "B", tags: ["y"], effectValue: 2.5 },
        ],
      });
      const roomOrder = Option.getOrThrow(
        yield* Schema.decodeUnknownEffect(roomOrderOptionSchema)(
          yield* client.messageRoomOrder.getMessageRoomOrder(messageKey),
        ),
      );
      expect(roomOrder.previousFills).toEqual(["old-a", "old-b"]);
      expect(roomOrder.fills).toEqual(["new-a", "new-b"]);
      expect(yield* database.rows("messageRoomOrderEntry")).toHaveLength(2);

      // Real IN endpoint and fast suite-level reset.
      const monitorUsers = yield* Schema.decodeUnknownEffect(usersSchema)(
        yield* client.userConfig.getMonitorDmEnabledUserConfigs({
          platform: "discord",
          userIds: ["user-1", "user-2", "user-3", "missing"],
        }),
      );
      expect(monitorUsers.map(({ userId }) => userId).sort()).toEqual(["user-1", "user-3"]);
      yield* database.reset;
      expect(yield* database.rows("configUserPlatform")).toEqual([]);
      expect(yield* database.rows("messageCheckin")).toEqual([]);
      expect(yield* database.rows("messageRoomOrder")).toEqual([]);
    }),
  );
});
