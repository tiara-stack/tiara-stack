import { expect, layer } from "@effect/vitest";
import { Context, Duration, Effect, Layer, Option } from "effect";
import type { WorkflowZeroContext as CanonicalWorkflowZeroContext } from "effect-zero-workflow";
import { makeTestSheetZeroDatabase } from "sheet-db-schema/testdb";
import {
  makeTrustedSheetPersistence,
  type TrustedSheetPersistenceShape,
} from "sheet-zero-server/persistence";
import type { WorkflowZeroContext as SharedWorkflowZeroContext } from "sheet-zero-server/authorization";

type TrustedViewIncludesRuns = "runs" extends keyof TrustedSheetPersistenceShape ? true : false;
const _trustedViewIncludesRuns: TrustedViewIncludesRuns = false;
const sharedWorkflowContext: SharedWorkflowZeroContext = {
  principalId: "composition-contract",
  visibilityKey: "service:composition-contract",
};
const _canonicalWorkflowContext: CanonicalWorkflowZeroContext = sharedWorkflowContext;

class WorkflowPersistenceFixture extends Context.Service<WorkflowPersistenceFixture>()(
  "WorkflowPersistenceFixture",
  {
    make: Effect.gen(function* () {
      const database = yield* makeTestSheetZeroDatabase();
      const persistence = yield* makeTrustedSheetPersistence(database.executor);
      return { database, persistence };
    }),
  },
) {}

const WorkflowPersistenceFixtureLayer = Layer.effect(
  WorkflowPersistenceFixture,
  WorkflowPersistenceFixture.make,
);

layer(WorkflowPersistenceFixtureLayer, { timeout: Duration.seconds(30) })(
  "sheet-workflows trusted persistence composition",
  (it) => {
    it.effect("executes representative in-process persistence without widening the policy", () =>
      Effect.gen(function* () {
        const { database, persistence } = yield* WorkflowPersistenceFixture;
        yield* database.reset;

        yield* persistence.slotState.upsertMessageSlotData({
          clientPlatform: "discord",
          clientId: "client-1",
          messageId: "message-1",
          day: 4,
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          createdByUserId: "user-1",
        });
        const slot = yield* persistence.slotState.getMessageSlotData({
          clientPlatform: "discord",
          clientId: "client-1",
          messageId: "message-1",
        });

        expect(Option.getOrThrow(slot as Option.Option<unknown>)).toMatchObject({
          day: 4,
          workspaceId: "workspace-1",
        });
        expect(sharedWorkflowContext).toEqual({
          principalId: "composition-contract",
          visibilityKey: "service:composition-contract",
        });
        expect("runs" in persistence).toBe(false);
      }),
    );
  },
);
