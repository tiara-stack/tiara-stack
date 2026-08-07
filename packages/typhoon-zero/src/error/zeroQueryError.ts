import { Schema } from "effect";
import { ReadonlyJSONValue } from "../schema/readonlyJsonValue";

const ZeroQueryErrorData = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  message: Schema.optional(Schema.String),
  details: Schema.optional(ReadonlyJSONValue),
});

export class ZeroQueryAppError extends Schema.TaggedErrorClass<ZeroQueryAppError>()(
  "ZeroQueryAppError",
  ZeroQueryErrorData,
) {}

const ZeroQueryHttpErrorData = Schema.Struct({
  ...ZeroQueryErrorData.fields,
  status: Schema.Number,
});

export class ZeroQueryHttpError extends Schema.TaggedErrorClass<ZeroQueryHttpError>()(
  "ZeroQueryHttpError",
  ZeroQueryHttpErrorData,
) {}

export class ZeroQueryZeroError extends Schema.TaggedErrorClass<ZeroQueryZeroError>()(
  "ZeroQueryZeroError",
  ZeroQueryErrorData,
) {}

export class ZeroQueryParseError extends Schema.TaggedErrorClass<ZeroQueryParseError>()(
  "ZeroQueryParseError",
  ZeroQueryErrorData,
) {}

export const ZeroQueryError = Schema.Union([
  ZeroQueryAppError,
  ZeroQueryHttpError,
  ZeroQueryZeroError,
  ZeroQueryParseError,
]);

export type ZeroQueryError = Schema.Schema.Type<typeof ZeroQueryError>;

export const RawZeroQueryError = Schema.Union([
  Schema.Struct({
    error: Schema.Literal("app"),
    ...ZeroQueryErrorData.fields,
  }),
  Schema.Struct({
    error: Schema.Literal("http"),
    ...ZeroQueryHttpErrorData.fields,
  }),
  Schema.Struct({
    error: Schema.Literal("zero"),
    ...ZeroQueryErrorData.fields,
  }),
  Schema.Struct({
    error: Schema.Literal("parse"),
    ...ZeroQueryErrorData.fields,
  }),
]);

export type RawZeroQueryError = Schema.Schema.Type<typeof RawZeroQueryError>;

export class QueryResultAppError extends Schema.TaggedErrorClass<QueryResultAppError>()(
  "QueryResultAppError",
  Schema.Struct({
    error: Schema.Literal("app"),
    id: Schema.String,
    name: Schema.String,
    message: Schema.optional(Schema.String),
    details: Schema.optional(ReadonlyJSONValue),
  }),
) {}

export class QueryResultParseError extends Schema.TaggedErrorClass<QueryResultParseError>()(
  "QueryResultParseError",
  Schema.Struct({
    error: Schema.Literal("parse"),
    id: Schema.String,
    name: Schema.String,
    message: Schema.optional(Schema.String),
    details: Schema.optional(ReadonlyJSONValue),
  }),
) {}

export const QueryResultError = Schema.Union([QueryResultAppError, QueryResultParseError]);

export type QueryResultError = Schema.Schema.Type<typeof QueryResultError>;

export class MutatorResultAppError extends Schema.TaggedErrorClass<MutatorResultAppError>()(
  "MutatorResultAppError",
  Schema.Struct({
    type: Schema.Literal("app"),
    message: Schema.String,
    details: Schema.optional(ReadonlyJSONValue),
  }),
) {}

export class MutatorResultZeroError extends Schema.TaggedErrorClass<MutatorResultZeroError>()(
  "MutatorResultZeroError",
  Schema.Struct({
    type: Schema.Literal("zero"),
    message: Schema.String,
  }),
) {}

export class ZeroClientExecutorError extends Schema.TaggedErrorClass<ZeroClientExecutorError>()(
  "ZeroClientExecutorError",
  Schema.Struct({
    operation: Schema.String,
    message: Schema.String,
    code: Schema.optional(Schema.String),
  }),
) {}

export const MutatorResultError = Schema.Union([MutatorResultAppError, MutatorResultZeroError]);

export type MutatorResultError = Schema.Schema.Type<typeof MutatorResultError>;
