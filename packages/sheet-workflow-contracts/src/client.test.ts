import { Effect, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { expectTypeOf } from "vitest";
import { InvocationId, makeRunReference } from "effect-zero-workflow/contract";
import type { WorkflowContractInput } from "effect-zero-workflow/contract";
import { CheckinsOpen } from "./catalog";
import type { SheetWorkflowClient, SheetWorkflowRun, SheetWorkflowRunReference } from "./client";

const invocationId = Schema.decodeUnknownSync(InvocationId)("123e4567-e89b-42d3-a456-426614174000");

describe("sheet Workflow Contract client", () => {
  it("specializes the common transport-neutral typed client interface", () => {
    type Client = SheetWorkflowClient<typeof CheckinsOpen, "enqueue", "observe">;
    const client: Client = {
      enqueue: () => Effect.succeed(makeRunReference(CheckinsOpen, invocationId)),
      get: () => Stream.succeed(Option.none()),
      list: () => Stream.succeed([]),
    };

    expectTypeOf<Parameters<Client["enqueue"]>[0]>().toEqualTypeOf<
      WorkflowContractInput<typeof CheckinsOpen>
    >();
    expectTypeOf<SheetWorkflowRunReference<typeof CheckinsOpen>>().toEqualTypeOf<
      ReturnType<typeof makeRunReference<typeof CheckinsOpen>>
    >();
    expectTypeOf<SheetWorkflowRun<typeof CheckinsOpen>["result"]>().toExtend<
      { readonly _tag: "Pending" } | { readonly _tag: "Success" } | { readonly _tag: "Failure" }
    >();
    expect(client).toBeDefined();
  });
});
