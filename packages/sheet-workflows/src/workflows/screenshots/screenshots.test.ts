import type { sheets_v4 } from "@googleapis/sheets";
import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Duration, Effect, Exit, Layer, Option, Ref, Schema } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { WorkflowInvocationUnauthorized } from "effect-zero-workflow/contract/transport";
import {
  ActionContext,
  dispatchWorkflowCommandBatch,
  WorkflowStore,
  type WorkflowCommand,
  type WorkflowRun,
  type WorkflowRunCursor,
} from "effect-zero-workflow";
import { ResponseReference, type SheetBotHttpClient } from "sheet-bot-api";
import { EffectivePrincipal } from "sheet-auth/identity";
import { ScreenshotsCaptureAndDeliver } from "sheet-workflow-contracts";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import { workflowTestInvocationId as invocationId } from "../shared/testHelpers";
import {
  googleFontCssUrl,
  rewriteGoogleFontCss,
  ScreenshotBrowser,
  screenshotBrowserBounds,
} from "./browser";
import { makeScreenshotsCaptureAndDeliverWorkflowBody, screenshotShardGroups } from "./definition";
import { screenshotWorkflowDefinitionVersion } from "./catalog";
import { ScreenshotsCaptureAndDeliverDefinition } from "./definitions";
import {
  makeScreenshotActionKey,
  makeScreenshotDeliveryKey,
  makeScreenshotInvocationId,
  makeScreenshotLogicalRequest,
  makeScreenshotSemanticFileIdentity,
} from "./keys";
import {
  ScreenshotCaptureExecution,
  ScreenshotExecution,
  ScreenshotRenderTargetSchema,
} from "./schema";
import {
  makeGoogleEmbeddedTableUrl,
  makeScreenshotSourceProvider,
  selectLegacyScreenshotSchedule,
} from "./sourceProvider";
import { screenshotCaptureOperationsLayer } from "./operations";
import { ScreenshotCaptureOperations } from "./service";
import { ScreenshotSourceOperations } from "./service";
import {
  reconcileDispatchWorkflowRuns,
  workflowCommandExecutorLayer,
} from "@/services/workflowCommands";

const responseReference = Schema.decodeUnknownSync(ResponseReference)("response-1");
const principal = Schema.decodeUnknownSync(EffectivePrincipal)({
  kind: "user",
  userId: "user-1",
  discordAccount: { accountId: "discord-user-1" },
});
const input = Schema.decodeUnknownSync(ScreenshotsCaptureAndDeliver.input)({
  workspaceId: "workspace-1",
  responseReference,
  conversationName: "alpha",
  day: 2,
});
const execution = Schema.decodeUnknownSync(ScreenshotExecution)({
  invocationId,
  input,
  principal,
});
const captureExecution = Schema.decodeUnknownSync(ScreenshotCaptureExecution)({
  ...execution,
  target: { url: "https://docs.google.com/render" },
});

const makeAuthorization = (
  authorize: ReadOnlyWorkflowAuthorization["Service"]["authorize"],
): ReadOnlyWorkflowAuthorization["Service"] => ({
  authorize,
  authorizeSlotOpen: () => Effect.die("unused"),
  authorizeCheckinRespond: () => Effect.die("unused"),
  authorizeRoomOrdersNavigate: () => Effect.die("unused"),
  authorizeRoomOrdersPinTentative: () => Effect.die("unused"),
  authorizeRoomOrdersSend: () => Effect.die("unused"),
  workspaceCapabilities: () => Effect.die("unused"),
});

const makeScreenshotDeliveryClient = (options: {
  readonly effects: Array<string>;
  readonly deliver?: boolean;
  readonly contentType?: string;
  readonly byteLength?: number;
}) =>
  ({
    delivery: {
      respond: ({ payload }: Parameters<SheetBotHttpClient["delivery"]["respond"]>[0]) =>
        Effect.sync(() => {
          options.effects.push("deliver");
          if (options.deliver === false) throw new Error("delivery must not be reached");
          const file = payload.message.files![0]!;
          return {
            deliveryKey: payload.deliveryKey,
            operation: "respond" as const,
            target: {
              _tag: "Response" as const,
              responseReference: payload.responseReference,
            },
            files: [
              {
                name: file.name,
                contentType: options.contentType ?? file.contentType,
                byteLength: options.byteLength ?? 777,
                deliveryBinding: file.deliveryBinding,
              },
            ],
          };
        }),
    },
  }) as unknown as SheetBotHttpClient;

const captureOperations = (options: {
  readonly effects: Array<string>;
  readonly authorize: ReadOnlyWorkflowAuthorization["Service"]["authorize"];
  readonly deliver?: boolean;
  readonly mismatchedReceipt?: boolean;
}) => {
  const bot = makeScreenshotDeliveryClient({
    effects: options.effects,
    ...(options.deliver === undefined ? {} : { deliver: options.deliver }),
    ...(options.mismatchedReceipt === true ? { contentType: "image/jpeg" } : {}),
  });
  return ScreenshotCaptureOperations.pipe(
    Effect.provide(screenshotCaptureOperationsLayer),
    Effect.provideService(ScreenshotBrowser, {
      capture: () =>
        Effect.sync(() => {
          options.effects.push("capture");
          return new Uint8Array([1, 2, 3, 4]);
        }),
    }),
    Effect.provideService(SheetBotDeliveryClient, { get: () => bot }),
    Effect.provideService(ReadOnlyWorkflowAuthorization, makeAuthorization(options.authorize)),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          SHEET_BOT_CLIENT_ID: "discord-main",
          SCREENSHOT_BROWSER_CONCURRENCY: 1,
        }),
      ),
    ),
  );
};

describe("screenshot capture workflow", () => {
  it("keeps source work on ordinary runners and browser work on the isolated shard", () => {
    expect(screenshotShardGroups).toEqual({
      workflow: "dispatch",
      source: "dispatch",
      browser: "browser",
    });
  });

  it("selects the first exact legacy conversation/day row", () => {
    expect(
      selectLegacyScreenshotSchedule(
        [
          [
            "alphabet",
            2,
            "Wrong",
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            "A1:A2",
          ],
          [
            " alpha ",
            "Day 2",
            " First ",
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            " B2:D4 ",
          ],
          [
            "alpha",
            2,
            "Second",
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            "E2:F4",
          ],
        ],
        "alpha",
        2,
      ),
    ).toEqual({ sheet: "First", screenshotRange: "B2:D4" });
  });

  it.effect(
    "resolves the bounded Google render target from metadata and schedule configuration",
    () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const client = {
          spreadsheets: {
            get: () => {
              calls.push("metadata");
              return Promise.resolve({
                data: {
                  sheets: [
                    { properties: { title: "Other", sheetId: 7 } },
                    { properties: { title: "Schedule", sheetId: 42 } },
                  ],
                },
              });
            },
            values: {
              batchGet: () => {
                calls.push("schedule");
                return Promise.resolve({
                  data: {
                    valueRanges: [
                      {
                        values: [
                          [
                            "alpha",
                            2,
                            "Schedule",
                            undefined,
                            undefined,
                            undefined,
                            undefined,
                            undefined,
                            undefined,
                            undefined,
                            "B2:D4",
                          ],
                        ],
                      },
                    ],
                  },
                });
              },
            },
          },
        } as unknown as sheets_v4.Sheets;

        const target = yield* makeScreenshotSourceProvider(client).resolve("sheet_1", "alpha", 2);

        expect(calls.sort()).toEqual(["metadata", "schedule"]);
        expect(target).toEqual({
          url: makeGoogleEmbeddedTableUrl("sheet_1", 42, "B2:D4"),
        });
        expect(target.url).toContain("https://docs.google.com/spreadsheets/d/sheet_1/htmlembed?");
        expect(target.url).toContain("gid=42");
        expect(target.url).toContain("range=B2%3AD4");
      }),
  );

  it.effect("reports a missing exact schedule as a declared source-resolution failure", () =>
    Effect.gen(function* () {
      const client = {
        spreadsheets: {
          get: () => Promise.resolve({ data: { sheets: [] } }),
          values: {
            batchGet: () =>
              Promise.resolve({ data: { valueRanges: [{ values: [["beta", 2, "Schedule"]] }] } }),
          },
        },
      } as unknown as sheets_v4.Sheets;

      const error = yield* Effect.flip(
        makeScreenshotSourceProvider(client).resolve("sheet_1", "alpha", 2),
      );

      expect(error).toMatchObject({
        _tag: "ScreenshotSourceResolutionError",
        code: "MissingSchedule",
      });
    }),
  );

  it("uses stable versioned keys without binding regenerated image bytes", () => {
    const logicalRequest = makeScreenshotLogicalRequest("workspace-1", "alpha", 2);
    const semanticIdentity = makeScreenshotSemanticFileIdentity(
      invocationId,
      "workspace-1",
      "alpha",
      2,
    );

    expect(makeScreenshotDeliveryKey(invocationId)).toContain(
      "screenshots.captureAndDeliver:1:capture-and-deliver-screenshot:2",
    );
    expect(makeScreenshotActionKey(invocationId, "resolve-screenshot-source")).toContain(
      ":resolve-screenshot-source:2:",
    );
    expect(logicalRequest).toMatch(/^screenshots\.captureAndDeliver:2:[A-Za-z0-9_-]+$/u);
    expect(logicalRequest).not.toBe(makeScreenshotLogicalRequest("workspace-1", "alpha", 3));
    expect(
      makeScreenshotLogicalRequest("x".repeat(1_000), "y".repeat(1_000), 2).length,
    ).toBeLessThan(512);
    expect(semanticIdentity).toBe(
      makeScreenshotSemanticFileIdentity(invocationId, "workspace-1", "alpha", 2),
    );
    expect(semanticIdentity).not.toBe(
      makeScreenshotSemanticFileIdentity(invocationId, "workspace-1", "alpha", 3),
    );
    expect(makeScreenshotInvocationId("discord-main", "interaction-1")).toBe(
      makeScreenshotInvocationId("discord-main", "interaction-1"),
    );
    expect(makeScreenshotInvocationId("discord-main", "interaction-1")).not.toBe(
      makeScreenshotInvocationId("discord-main", "interaction-2"),
    );
  });

  it("rewrites only Google font-family declarations and keeps browser work bounded", () => {
    expect(
      rewriteGoogleFontCss(
        "@font-face { font-family: 'Lexend'; src: url(x); } body { color: red; }",
      ),
    ).toBe("@font-face { font-family: 'docs-Lexend'; src: url(x); } body { color: red; }");
    expect(googleFontCssUrl).toContain("fonts.googleapis.com/css2");
    expect(screenshotBrowserBounds).toMatchObject({
      navigationTimeoutMillis: 30_000,
      maximumViewportWidth: 8_192,
      maximumPngByteLength: 8 * 1024 * 1024,
    });
    expect(
      Schema.decodeUnknownSync(ScreenshotRenderTargetSchema)({
        url: "https://docs.google.com/spreadsheets/d/sheet_1/htmlembed",
      }),
    ).toBeDefined();
    expect(() =>
      Schema.decodeUnknownSync(ScreenshotRenderTargetSchema)({ url: "https://example.com/render" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ScreenshotRenderTargetSchema)({
        url: "http://docs.google.com/render",
      }),
    ).toThrow();
  });

  it.effect("reauthorizes immediately before delivery and trusts confirmed receipt evidence", () =>
    Effect.gen(function* () {
      const effects: Array<string> = [];
      const operations = yield* captureOperations({
        effects,
        authorize: () =>
          Effect.sync(() => {
            effects.push("authorize");
          }),
      });

      const result = yield* operations.captureAndDeliver(captureExecution);

      expect(effects).toEqual(["capture", "authorize", "deliver"]);
      expect(result.byteLength).toBe(777);
      expect(result.receipt.files?.[0]).toMatchObject({
        name: "screenshot.png",
        contentType: "image/png",
        byteLength: 777,
      });
    }),
  );

  it.effect("rejects delivery receipts with mismatched screenshot evidence", () =>
    Effect.gen(function* () {
      const effects: Array<string> = [];
      const operations = yield* captureOperations({
        effects,
        mismatchedReceipt: true,
        authorize: () => Effect.void,
      });

      const exit = yield* Effect.exit(operations.captureAndDeliver(captureExecution));
      const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();

      expect(effects).toEqual(["capture", "deliver"]);
      expect(Option.getOrNull(error)).toMatchObject({
        _tag: "DeliveryRejected",
        recoveryRequired: false,
      });
    }),
  );

  it.effect("stops after capture when workspace-monitor authority is revoked", () =>
    Effect.gen(function* () {
      const effects: Array<string> = [];
      const operations = yield* captureOperations({
        effects,
        deliver: false,
        authorize: () =>
          Effect.sync(() => {
            effects.push("authorize");
          }).pipe(
            Effect.andThen(
              Effect.fail(new WorkflowInvocationUnauthorized({ message: "monitor revoked" })),
            ),
          ),
      });

      const exit = yield* Effect.exit(operations.captureAndDeliver(captureExecution));
      const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();

      expect(effects).toEqual(["capture", "authorize"]);
      expect(Option.getOrNull(error)).toEqual({
        _tag: "AuthorizationRevoked",
        policy: ScreenshotsCaptureAndDeliver.authorizationPolicy.policy,
      });
    }),
  );

  it.effect("returns only public delivery evidence from the workflow body", () =>
    Effect.gen(function* () {
      const deliveryKey = makeScreenshotDeliveryKey(invocationId);
      const result = yield* makeScreenshotsCaptureAndDeliverWorkflowBody({
        resolve: () => Effect.succeed({ url: "https://docs.google.com/render" }),
        captureAndDeliver: () =>
          Effect.succeed({
            receipt: {
              deliveryKey,
              operation: "respond" as const,
              target: { _tag: "Response" as const, responseReference },
            },
            byteLength: 321,
          }),
      })(execution);

      expect(result).toEqual({
        workspaceId: "workspace-1",
        conversationName: "alpha",
        day: 2,
        byteLength: 321,
        deliveryReceipts: [
          {
            deliveryKey,
            operation: "respond",
            target: { _tag: "Response", responseReference },
          },
        ],
      });
      expect(JSON.stringify(result)).not.toContain("https://docs.google.com/render");
      expect(JSON.stringify(result)).not.toContain("content");
    }),
  );

  it.effect("reaches a terminal delivery result through the replacement command runtime", () =>
    Effect.gen(function* () {
      const effects: Array<string> = [];
      const delivery = makeScreenshotDeliveryClient({ effects, byteLength: 4 });
      const workflow = ScreenshotsCaptureAndDeliverDefinition.workflow;
      const executionId = yield* workflow.executionId(execution);
      const runId = "screenshot-replacement-run";
      const command: WorkflowCommand = {
        commandId: `start:${runId}`,
        runId,
        workflowName: workflow.name,
        definitionVersion: screenshotWorkflowDefinitionVersion,
        executionId,
        kind: "start",
        payload: Schema.decodeUnknownSync(Schema.Json)(execution),
        status: "delivering",
        attempts: 1,
        maxAttempts: 3,
        leaseOwner: "screenshot-test",
        leaseToken: 1,
      };
      const run: WorkflowRun = {
        runId,
        workflowName: workflow.name,
        definitionVersion: screenshotWorkflowDefinitionVersion,
        executionId,
        status: "running",
        result: null,
        error: null,
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      };
      const claimed = yield* Ref.make(true);
      const delivered = yield* Ref.make(false);
      const runStatuses = yield* Ref.make<ReadonlyArray<string>>([]);
      const runResults = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const storeLayer = Layer.mock(WorkflowStore)({
        claim: () =>
          Ref.modify(claimed, (isClaimed) => [isClaimed ? [command] : [], false] as const),
        markCommandDelivered: () => Ref.set(delivered, true).pipe(Effect.as(true)),
        listRuns: () => Effect.succeed([run]),
        markRun: (_runId, status, details) =>
          Effect.all(
            [
              Ref.update(runStatuses, (statuses) => [...statuses, status]),
              Ref.update(runResults, (results) => [...results, details?.result]),
            ],
            { discard: true },
          ),
      });
      const sourceLayer = Layer.succeed(ScreenshotSourceOperations, {
        resolve: () =>
          Effect.sync(() => {
            effects.push("resolve");
            return { url: "https://docs.google.com/render" };
          }),
      });
      const captureLayer = screenshotCaptureOperationsLayer.pipe(
        Layer.provide(
          Layer.mock(ScreenshotBrowser)({
            capture: () =>
              Effect.sync(() => {
                effects.push("capture");
                return new Uint8Array([1, 2, 3, 4]);
              }),
          }),
        ),
        Layer.provide(Layer.succeed(SheetBotDeliveryClient, { get: () => delivery })),
        Layer.provide(
          Layer.succeed(
            ReadOnlyWorkflowAuthorization,
            makeAuthorization(() => Effect.void),
          ),
        ),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              SHEET_BOT_CLIENT_ID: "discord-main",
              SCREENSHOT_BROWSER_CONCURRENCY: 1,
            }),
          ),
        ),
      );
      const engineLayer = WorkflowEngine.layerMemory;
      const workflowHandlersLayer = Layer.mergeAll(
        ScreenshotsCaptureAndDeliverDefinition.workflowLayer,
        ...ScreenshotsCaptureAndDeliverDefinition.actions.map((action) => action.toLayer()),
      ).pipe(
        Layer.provide(sourceLayer),
        Layer.provide(captureLayer),
        Layer.provide(
          Layer.succeed(ActionContext, {
            query: () => Effect.die("unused"),
            mutate: () => Effect.die("unused"),
          }),
        ),
      );
      const runtimeLayer = Layer.mergeAll(workflowCommandExecutorLayer, workflowHandlersLayer).pipe(
        Layer.provideMerge(Layer.mergeAll(engineLayer, storeLayer)),
      );

      yield* Effect.gen(function* () {
        const dispatched = yield* dispatchWorkflowCommandBatch({
          batchSize: 1,
          maxAttempts: 3,
          retryDelay: () => Duration.zero,
        });
        expect(dispatched).toBe(1);
        const cursor = yield* Ref.make<WorkflowRunCursor | undefined>(undefined);
        yield* reconcileDispatchWorkflowRuns(cursor).pipe(
          Effect.tap(() => Effect.yieldNow),
          Effect.repeat({
            times: 19,
            until: () =>
              Ref.get(runStatuses).pipe(Effect.map((statuses) => statuses.includes("succeeded"))),
          }),
        );
      }).pipe(Effect.provide(runtimeLayer));

      expect(yield* Ref.get(delivered)).toBe(true);
      expect(effects).toEqual(["resolve", "capture", "deliver"]);
      expect(yield* Ref.get(runStatuses)).toContain("succeeded");
      expect(yield* Ref.get(runResults)).toContainEqual(
        expect.objectContaining({
          deliveryReceipts: [
            expect.objectContaining({
              deliveryKey: makeScreenshotDeliveryKey(invocationId),
              operation: "respond",
              target: { _tag: "Response", responseReference },
            }),
          ],
        }),
      );
    }),
  );
});
