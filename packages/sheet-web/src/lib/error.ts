import { Schema } from "effect";

export class RequestError extends Schema.TaggedError<RequestError>()("RequestError", {
  reason: Schema.Literal("Transport", "Encode", "InvalidUrl"),
  cause: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.String),
}) {}

export class ResponseError extends Schema.TaggedError<ResponseError>()("ResponseError", {
  reason: Schema.Literal("StatusCode", "Decode", "EmptyBody"),
  cause: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.String),
}) {}
