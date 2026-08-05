import type { Effect } from "effect";
import type { ZeroClient } from "typhoon-zero/client";
import { ZeroApiClient } from "typhoon-zero/zeroApi";
import { SheetZeroApi } from "./api";
import { mutators } from "./mutators";
import { queries } from "./queries";
import type { Schema } from "./schema";

/**
 * Application-facing Sheet client. Its root is intentionally not workflow-
 * specific: references can point at ordinary reactive data or mutations, while
 * durable execution remains an implementation detail of selected operations.
 */
export type SheetClient = ZeroApiClient.FunctionClient<typeof SheetZeroApi, "public">;

export const makeSheetClient = (
  zeroClient: ZeroClient.ZeroClientExecutor<Schema, unknown>,
): Effect.Effect<SheetClient> =>
  ZeroApiClient.makeFunctionsWithService(SheetZeroApi, zeroClient, {
    queries,
    mutators,
  });
