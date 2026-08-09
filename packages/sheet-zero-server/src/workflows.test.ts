import { Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { InvocationId, workflowContractKey } from "effect-zero-workflow/contract";
import { workflowContractZeroGroupIdentifier } from "effect-zero-workflow/contract/transport";
import { UserId } from "sheet-auth/identity";
import { DiscordLoadProfile, SheetWorkflowContractCatalog } from "sheet-workflow-contracts";
import { ZeroApiEndpoint } from "typhoon-zero/zeroApi";
import { makeSheetWorkflowZeroGroups, type SheetWorkflowZeroContext } from "./workflows";

type SheetWorkflowRunQuery = NonNullable<Parameters<typeof makeSheetWorkflowZeroGroups>[1]>;

const invocationId = Schema.decodeUnknownSync(InvocationId)("123e4567-e89b-42d3-a456-426614174000");

const context: SheetWorkflowZeroContext = {
  ownerKey: "user:user-1",
  principal: { kind: "user", userId: Schema.decodeUnknownSync(UserId)("user-1") },
};

const makeQueryRecorder = () => {
  const calls: Array<readonly unknown[]> = [];
  const query = {
    limit: (limit: number) => {
      calls.push(["limit", limit]);
      return query;
    },
    one: () => {
      calls.push(["one"]);
      return query;
    },
    orderBy: (field: string, direction: string) => {
      calls.push(["orderBy", field, direction]);
      return query;
    },
    start: (row: object, options: object) => {
      calls.push(["start", row, options]);
      return query;
    },
    where: (field: string, operator: string, value: unknown) => {
      calls.push(["where", field, operator, value]);
      return query;
    },
  };
  return {
    calls,
    query: query as unknown as SheetWorkflowRunQuery,
  };
};

const makeGroups = (workflowRun: SheetWorkflowRunQuery = makeQueryRecorder().query) =>
  makeSheetWorkflowZeroGroups(() => Promise.resolve(), workflowRun);

const profileQueries = (workflowRun: SheetWorkflowRunQuery) => {
  const group = makeGroups(workflowRun).find(
    ({ identifier }) => identifier === workflowContractZeroGroupIdentifier(DiscordLoadProfile),
  );
  const get = group?.endpoints.get;
  const list = group?.endpoints.list;
  if (
    get === undefined ||
    list === undefined ||
    !ZeroApiEndpoint.isKind("query")(get) ||
    !ZeroApiEndpoint.isKind("query")(list)
  ) {
    throw new Error("Missing generated Workflow Contract queries");
  }
  return { get, list };
};

describe("Sheet Workflow Contract Zero registry", () => {
  it("publishes exactly three explicit procedures per declared contract", () => {
    const groups = makeGroups();

    expect(groups).toHaveLength(SheetWorkflowContractCatalog.length);
    expect(groups.flatMap((group) => Object.values(group.endpoints))).toHaveLength(
      SheetWorkflowContractCatalog.length * 3,
    );
    expect(groups.some((group) => group.identifier === "workflows")).toBe(false);
  });

  it("isolates get observations by invocation, owner, and contract version", () => {
    const recorder = makeQueryRecorder();
    const { get } = profileQueries(recorder.query);

    get.query({ args: { invocationId }, ctx: context });

    expect(recorder.calls).toEqual([
      ["where", "runId", "=", invocationId],
      ["where", "workflowName", "=", workflowContractKey(DiscordLoadProfile)],
      ["where", "visibilityKey", "=", context.ownerKey],
      ["one"],
    ]);
  });

  it("bounds, filters, orders, and cursors owner-scoped lists", () => {
    const recorder = makeQueryRecorder();
    const { list } = profileQueries(recorder.query);
    const submittedAt = new Date("2026-08-09T00:00:00.000Z");

    list.query({
      args: {
        states: ["Pending", "Failure"],
        cursor: { submittedAt, invocationId },
        limit: 12,
      },
      ctx: context,
    });

    expect(recorder.calls).toEqual([
      ["where", "workflowName", "=", workflowContractKey(DiscordLoadProfile)],
      ["where", "visibilityKey", "=", context.ownerKey],
      ["where", "status", "IN", ["pending", "running", "failed", "cancelled"]],
      ["orderBy", "createdAt", "desc"],
      ["orderBy", "runId", "desc"],
      ["limit", 12],
      ["start", { createdAt: submittedAt.getTime(), runId: invocationId }, { inclusive: false }],
    ]);
  });
});
