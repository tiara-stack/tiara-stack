import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Effect, Option, Schema, Stream } from "effect";
import type { ZeroClient } from "typhoon-zero/client";
import { CheckinMessagesLoad } from "sheet-workflow-contracts";
import { InvocationId } from "effect-zero-workflow/contract";
import { serviceApi } from "./api";
import { makeCheckinMessagesLoadZeroObserver } from "./client";
import type { Schema as SheetZeroSchema } from "./schema";
import { makeSheetServiceClient } from "./serverClient";
import { serverMutators } from "./serverRegistries";

describe("Sheet service client", () => {
  it.effect("registers service-only workflow functions", () =>
    Effect.gen(function* () {
      const mutate = vi.fn<ZeroClient.ZeroClientExecutor<SheetZeroSchema, unknown>["mutate"]>(() =>
        Effect.succeed({
          client: () => Effect.void,
          server: () => Effect.void,
        }),
      );
      const client = yield* makeSheetServiceClient({
        mutate,
        run: () => Effect.die("query execution is not used"),
        stream: () => Stream.die("query streaming is not used"),
      });

      const request = {
        caller: { principalId: "account-1" },
        workflow: {
          runId: "run-1",
          workflowName: "checkin",
          definitionVersion: "1",
          executionId: "execution-1",
          payload: { value: 1 },
        },
      } as const;

      yield* client.execute(serviceApi.runs.enqueueAsCaller, request);

      expect(mutate).toHaveBeenCalledOnce();
      const mutation = mutate.mock.calls[0]![0];
      expect(mutation.mutator).toBe(serverMutators.runs.enqueueAsCaller);
      expect(mutation.mutator.mutatorName).toBe(
        `${serviceApi.runs.enqueueAsCaller.group}.${serviceApi.runs.enqueueAsCaller.name}`,
      );
      expect(mutation.args).toEqual(request);
    }),
  );

  it.effect("materializes the saved-message load from one reactive Zero query", () =>
    Effect.gen(function* () {
      const invocationId = Schema.decodeUnknownSync(InvocationId)(
        "123e4567-e89b-42d3-a456-426614174000",
      );
      const reference = {
        invocationId,
        contractIdentity: CheckinMessagesLoad.identity,
        wireVersion: CheckinMessagesLoad.wireVersion,
      } as const;
      const loaded = Schema.decodeUnknownSync(CheckinMessagesLoad.success)({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        conversationName: "running",
        binding: { eventStartEpochMs: 1, messageSetGeneration: 1 },
        messages: [],
      });
      const observer = yield* makeCheckinMessagesLoadZeroObserver({
        run: () => Effect.die("query execution is not used"),
        stream: (() =>
          Stream.make(null, {
            runId: invocationId,
            status: "succeeded",
            result: loaded,
            error: null,
            completedAt: 2,
            createdAt: 1,
            updatedAt: 2,
          })) as ZeroClient.ZeroClientExecutor<SheetZeroSchema, unknown>["stream"],
        mutate: () => Effect.die("observation must not mutate"),
      });

      const observed = yield* Stream.runCollect(observer.get(reference));

      expect(observed).toHaveLength(2);
      expect(Option.isNone(observed[0]!)).toBe(true);
      expect(Option.getOrThrow(observed[1]!).result).toMatchObject({
        _tag: "Success",
        value: loaded,
      });
    }),
  );

  it.effect("does not observe a reference from another contract or wire version", () =>
    Effect.gen(function* () {
      const stream = vi.fn(() => Stream.die("invalid references must not query Zero"));
      const observer = yield* makeCheckinMessagesLoadZeroObserver({
        run: () => Effect.die("query execution is not used"),
        stream: stream as ZeroClient.ZeroClientExecutor<SheetZeroSchema, unknown>["stream"],
        mutate: () => Effect.die("observation must not mutate"),
      });
      const invocationId = Schema.decodeUnknownSync(InvocationId)(
        "123e4567-e89b-42d3-a456-426614174000",
      );

      const invalidContractObserved = yield* Stream.runCollect(
        observer.get({
          invocationId,
          contractIdentity: "checkinMessages.save",
          wireVersion: "v1",
        }),
      );
      const invalidWireVersionObserved = yield* Stream.runCollect(
        observer.get({
          invocationId,
          contractIdentity: CheckinMessagesLoad.identity,
          wireVersion: "v2",
        }),
      );

      expect(invalidContractObserved).toEqual([Option.none()]);
      expect(invalidWireVersionObserved).toEqual([Option.none()]);
      expect(stream).not.toHaveBeenCalled();
    }),
  );
});
