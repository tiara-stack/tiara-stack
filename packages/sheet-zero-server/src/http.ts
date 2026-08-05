import type { Database } from "@rocicorp/zero/server";
import { Effect } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import type { HttpApi } from "effect/unstable/httpapi";
import { schema } from "sheet-zero-api";
import { serverMutators, serverQueries } from "sheet-zero-api/server";
import { makeZeroHttpLive, ZeroHttpApi } from "typhoon-zero/server";
import { SheetZeroAuthorization } from "./authorization";

export interface SheetZeroHttpLayerOptions<
  ZqlEffect extends Effect.Effect<Database<unknown>, unknown, unknown>,
> {
  readonly zql: ZqlEffect;
}

export const makeSheetZeroHttpLayer = <
  ApiId extends string,
  ZqlEffect extends Effect.Effect<Database<unknown>, any, any>,
>(
  api: HttpApi.HttpApi<ApiId, typeof ZeroHttpApi>,
  options: SheetZeroHttpLayerOptions<ZqlEffect>,
) =>
  makeZeroHttpLive(api, {
    schema,
    queries: serverQueries,
    mutators: serverMutators,
    context: (procedureNames) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = yield* SheetZeroAuthorization;
        return yield* authorization.authorize(procedureNames, request.headers);
      }),
    zql: options.zql,
  });
