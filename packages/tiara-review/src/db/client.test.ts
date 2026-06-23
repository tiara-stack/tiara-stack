import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "@effect/vitest";
import { withImmediateTransaction } from "./client";

const fakeSql = (input: {
  readonly failOn?: string;
  readonly calls: Array<string>;
}): SqlClient.SqlClient =>
  ({
    unsafe: (statement: string) =>
      Effect.gen(function* () {
        input.calls.push(statement);
        if (statement === input.failOn) {
          return yield* Effect.fail(new Error(`${statement} failed`));
        }
      }),
  }) as unknown as SqlClient.SqlClient;

describe("withImmediateTransaction", () => {
  it.effect("rolls back and re-raises when commit fails", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const sql = fakeSql({ calls, failOn: "COMMIT" });

      const exit = yield* Effect.exit(withImmediateTransaction(sql, Effect.succeed("ok")));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(calls).toEqual(["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"]);
    }),
  );
});
