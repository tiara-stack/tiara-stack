import { Schema } from "effect";
import {
  MutatorResultAppError,
  MutatorResultZeroError,
  QueryResultAppError,
  QueryResultParseError,
  ZeroClientExecutorError,
} from "../error/zeroQueryError";

export {
  MutatorResultAppError,
  MutatorResultZeroError,
  QueryResultAppError,
  QueryResultParseError,
  ZeroClientExecutorError,
} from "../error/zeroQueryError";

export type QueryError =
  | QueryResultAppError
  | QueryResultParseError
  | Schema.SchemaError
  | ZeroClientExecutorError;

export type MutatorError =
  | MutatorResultAppError
  | MutatorResultZeroError
  | Schema.SchemaError
  | ZeroClientExecutorError;
