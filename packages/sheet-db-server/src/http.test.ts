import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeSheetZeroHttpLayer } from "sheet-zero-server/http";
import { Api } from "./api";

it("composes the shared Sheet Zero implementation into the database runtime", () => {
  const handlers = makeSheetZeroHttpLayer(Api, {
    zql: Effect.die("not executed by the composition contract"),
  });

  expect(handlers).toBeDefined();
});
