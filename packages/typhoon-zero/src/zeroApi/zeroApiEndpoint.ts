import type {
  Query,
  ReadonlyJSONValue,
  RunOptions,
  Schema as ZeroSchema,
  Transaction,
} from "@rocicorp/zero";
import type { Pipeable } from "effect/Pipeable";
import { pipeArguments } from "effect/Pipeable";
import { Predicate, type Schema } from "effect";

const TypeId = "~typhoon-zero/ZeroApiEndpoint";

export type Kind = "query" | "mutator";

export interface QueryEndpoint<
  Name extends string,
  Request extends Schema.Top,
  Success extends Schema.Top,
  TTable extends keyof TSchema["tables"] & string,
  TSchema extends ZeroSchema,
  TReturn,
  TContext,
> extends Pipeable {
  readonly [TypeId]: typeof TypeId;
  readonly kind: "query";
  readonly name: Name;
  readonly request: Request;
  readonly success: Success;
  readonly runOptions: RunOptions | undefined;
  readonly query: (options: {
    readonly args: Schema.Schema.Type<Request>;
    readonly ctx: TContext;
  }) => Query<TTable, TSchema, TReturn>;
}

export interface MutatorEndpoint<
  Name extends string,
  Request extends Schema.Top,
  TSchema extends ZeroSchema,
  TContext,
  TWrappedTransaction,
> extends Pipeable {
  readonly [TypeId]: typeof TypeId;
  readonly kind: "mutator";
  readonly name: Name;
  readonly request: Request;
  readonly mutator: (options: {
    readonly args: Schema.Schema.Type<Request>;
    readonly ctx: TContext;
    readonly tx: Transaction<TSchema, TWrappedTransaction>;
  }) => Promise<void>;
}

export type AnyQuery = QueryEndpoint<any, any, any, any, any, any, any>;
export type AnyMutator = MutatorEndpoint<any, any, any, any, any>;
export type Any = AnyQuery | AnyMutator;

const Proto = {
  [TypeId]: TypeId,
  pipe() {
    return pipeArguments(this, arguments);
  },
};

const make = <A extends Record<PropertyKey, unknown>>(options: A): A & Pipeable => {
  const self = Object.create(Proto);
  return Object.assign(self, options);
};

export const query = <
  const Name extends string,
  Request extends Schema.Top,
  Success extends Schema.Top,
  TSchema extends ZeroSchema,
  TTable extends keyof TSchema["tables"] & string,
  TReturn,
  TContext = unknown,
>(
  name: Name,
  options: {
    readonly request: Request;
    readonly success: Success;
    readonly runOptions?: RunOptions | undefined;
    readonly query: (options: {
      readonly args: Schema.Schema.Type<Request>;
      readonly ctx: TContext;
    }) => Query<TTable, TSchema, TReturn>;
  },
): QueryEndpoint<Name, Request, Success, TTable, TSchema, TReturn, TContext> =>
  make({
    kind: "query",
    name,
    request: options.request,
    success: options.success,
    runOptions: options.runOptions,
    query: options.query,
  }) as QueryEndpoint<Name, Request, Success, TTable, TSchema, TReturn, TContext>;

export const mutator = <
  const Name extends string,
  Request extends Schema.Top,
  TSchema extends ZeroSchema,
  TContext = unknown,
  TWrappedTransaction = unknown,
>(
  name: Name,
  options: {
    readonly request: Request;
    readonly mutator: (options: {
      readonly args: Schema.Schema.Type<Request>;
      readonly ctx: TContext;
      readonly tx: Transaction<TSchema, TWrappedTransaction>;
    }) => Promise<void>;
  },
): MutatorEndpoint<Name, Request, TSchema, TContext, TWrappedTransaction> =>
  make({
    kind: "mutator",
    name,
    request: options.request,
    mutator: options.mutator,
  }) as MutatorEndpoint<Name, Request, TSchema, TContext, TWrappedTransaction>;

export const isZeroApiEndpoint = (input: unknown): input is Any =>
  Predicate.hasProperty(input, TypeId);

export type RequestType<Endpoint extends Any> = Endpoint extends
  | QueryEndpoint<any, infer Request, any, any, any, any, any>
  | MutatorEndpoint<any, infer Request, any, any, any>
  ? Schema.Schema.Type<Request>
  : never;

export type RequestEncoded<Endpoint extends Any> = Endpoint extends
  | QueryEndpoint<any, infer Request, any, any, any, any, any>
  | MutatorEndpoint<any, infer Request, any, any, any>
  ? Request["Encoded"] & ReadonlyJSONValue
  : never;

export type SuccessType<Endpoint extends Any> =
  Endpoint extends QueryEndpoint<any, any, infer Success, any, any, any, any>
    ? Schema.Schema.Type<Success>
    : never;
