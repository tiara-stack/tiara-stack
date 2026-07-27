import { expect, layer } from "@effect/vitest";
import { Cause, Context, Duration, Effect, Exit, Layer, Option } from "effect";
import { makeTestSheetZeroClient, type TestSheetZero } from "../testdb";
import { WorkspaceConfigService } from "./workspaceConfig";

const StatefulTestZero = Context.Service<TestSheetZero>("WorkspaceConfigStatefulTestZero");
const StatefulTestZeroLayer = Layer.effect(StatefulTestZero, makeTestSheetZeroClient());

const makeService = (testZero: TestSheetZero) =>
  WorkspaceConfigService.make.pipe(Effect.provide(testZero.layer));

const workspaceRow = {
  workspaceId: "workspace-1",
  sheetId: "sheet-1",
  autoCheckin: true,
  monitorConversationId: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  deletedAt: null,
} as const;

const conversationRow = {
  workspaceId: "workspace-1",
  conversationId: "monitor-channel",
  name: "mana-moni",
  running: false,
  roleId: null,
  checkinConversationId: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  deletedAt: null,
} as const;

const firstFailure = <E>(exit: Exit.Exit<unknown, E>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

layer(StatefulTestZeroLayer, { timeout: Duration.seconds(30) })(
  "WorkspaceConfigService monitor channel",
  (it) => {
    it.effect("sets, preserves, and unsets the optional monitor channel", () =>
      Effect.gen(function* () {
        const testZero = yield* StatefulTestZero;
        yield* testZero.reset;
        yield* testZero.seed({ configWorkspace: [workspaceRow] });
        const service = yield* makeService(testZero);

        const set = yield* service.upsertWorkspaceConfig("workspace-1", {
          monitorConversationId: "monitor-channel",
        });
        expect(set.monitorConversationId).toEqual(Option.some("monitor-channel"));

        const preserved = yield* service.upsertWorkspaceConfig("workspace-1", {
          autoCheckin: false,
        });
        expect(preserved.monitorConversationId).toEqual(Option.some("monitor-channel"));

        const unset = yield* service.upsertWorkspaceConfig("workspace-1", {
          monitorConversationId: null,
        });
        expect(unset.monitorConversationId).toEqual(Option.none());
      }),
    );

    it.effect("rejects selecting an existing running room as the monitor channel", () =>
      Effect.gen(function* () {
        const testZero = yield* StatefulTestZero;
        yield* testZero.reset;
        yield* testZero.seed({
          configWorkspace: [workspaceRow],
          configWorkspaceConversation: [{ ...conversationRow, running: true }],
        });
        const service = yield* makeService(testZero);

        const exit = yield* Effect.exit(
          service.upsertWorkspaceConfig("workspace-1", {
            monitorConversationId: "monitor-channel",
          }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        expect(firstFailure(exit)?.message).toBe(
          "The monitor channel cannot be a registered running channel",
        );
      }),
    );

    it.effect("rejects marking the configured monitor channel as running", () =>
      Effect.gen(function* () {
        const testZero = yield* StatefulTestZero;
        yield* testZero.reset;
        yield* testZero.seed({
          configWorkspace: [{ ...workspaceRow, monitorConversationId: "monitor-channel" }],
          configWorkspaceConversation: [conversationRow],
        });
        const service = yield* makeService(testZero);

        const exit = yield* Effect.exit(
          service.upsertWorkspaceConversationConfig("workspace-1", "monitor-channel", {
            running: true,
          }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        expect(firstFailure(exit)?.message).toBe(
          "The monitor channel cannot be a registered running channel",
        );
      }),
    );

    it.effect("keeps the separation invariant under concurrent updates", () =>
      Effect.gen(function* () {
        const testZero = yield* StatefulTestZero;
        yield* testZero.reset;
        yield* testZero.seed({
          configWorkspace: [workspaceRow],
          configWorkspaceConversation: [conversationRow],
        });
        const service = yield* makeService(testZero);

        const exits = yield* Effect.all(
          [
            Effect.exit(
              service.upsertWorkspaceConfig("workspace-1", {
                monitorConversationId: "monitor-channel",
              }),
            ),
            Effect.exit(
              service.upsertWorkspaceConversationConfig("workspace-1", "monitor-channel", {
                running: true,
              }),
            ),
          ],
          { concurrency: 2 },
        );

        const [workspaceExit, conversationExit] = exits;
        expect(Exit.isFailure(workspaceExit) === Exit.isFailure(conversationExit)).toBe(false);
        const [workspace] = yield* testZero.rows("configWorkspace");
        const [conversation] = yield* testZero.rows("configWorkspaceConversation");
        expect(
          workspace?.monitorConversationId === "monitor-channel" && conversation?.running === true,
        ).toBe(false);
      }),
    );
  },
);
