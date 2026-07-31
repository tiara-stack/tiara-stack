import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Effect, Stream } from "effect";
import type { ZeroClient } from "typhoon-zero/client";
import { serviceApi } from "./api";
import { makeSheetServiceClient } from "./client";
import { mutators } from "./mutators";
import type { Schema } from "./schema";

describe("Sheet service client", () => {
  it.effect("registers service-only workflow functions", () =>
    Effect.gen(function* () {
      const mutate = vi.fn<ZeroClient.ZeroClientExecutor<Schema, unknown>["mutate"]>(() =>
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
      expect(mutation.mutator).toBe(mutators.runs.enqueueAsCaller);
      expect(mutation.mutator.mutatorName).toBe(
        `${serviceApi.runs.enqueueAsCaller.group}.${serviceApi.runs.enqueueAsCaller.name}`,
      );
      expect(mutation.args).toEqual(request);
    }),
  );
});
