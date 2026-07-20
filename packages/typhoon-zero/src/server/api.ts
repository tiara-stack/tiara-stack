import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { ReadonlyJSONValue } from "../schema";

const ZeroDispatchErrorFields = {
  procedure: Schema.String,
  message: Schema.String,
};

export class ZeroDispatchBadRequestError extends Schema.TaggedErrorClass<ZeroDispatchBadRequestError>()(
  "ZeroDispatchBadRequestError",
  ZeroDispatchErrorFields,
  { httpApiStatus: 400 },
) {}

export class ZeroDispatchNotFoundError extends Schema.TaggedErrorClass<ZeroDispatchNotFoundError>()(
  "ZeroDispatchNotFoundError",
  ZeroDispatchErrorFields,
  { httpApiStatus: 404 },
) {}

export const ZeroDispatchError = Schema.Union([
  ZeroDispatchBadRequestError,
  ZeroDispatchNotFoundError,
]);

export type ZeroDispatchError = typeof ZeroDispatchError.Type;

export class ZeroHttpApi extends HttpApiGroup.make("zero")
  .add(
    HttpApiEndpoint.post("query", "/zero/query", {
      success: ReadonlyJSONValue,
      payload: ReadonlyJSONValue,
      error: ZeroDispatchError,
    }),
  )
  .add(
    HttpApiEndpoint.post("mutate", "/zero/mutate", {
      success: ReadonlyJSONValue,
      query: Schema.Record(Schema.String, Schema.String),
      payload: ReadonlyJSONValue,
      error: ZeroDispatchError,
    }),
  )
  .annotate(OpenApi.Title, "Zero")
  .annotate(OpenApi.Description, "Zero endpoints") {}
