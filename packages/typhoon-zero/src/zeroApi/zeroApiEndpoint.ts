import type {
  Query,
  ReadonlyJSONValue,
  RunOptions,
  DefaultSchema,
  Schema as ZeroSchema,
  Transaction,
} from "@rocicorp/zero";
import type { Pipeable } from "effect/Pipeable";
import { pipeArguments } from "effect/Pipeable";
import { Predicate, type Schema } from "effect";

const TypeId = "~typhoon-zero/ZeroApiEndpoint";

export type Kind = "query" | "mutator";
export type Visibility = "public" | "service" | "internal";

export interface QueryEndpoint<
  Name extends string,
  Request extends Schema.Top,
  Success extends Schema.Top,
  TTable extends keyof TSchema["tables"] & string,
  TSchema extends ZeroSchema,
  TReturn,
  TContext,
  TVisibility extends Visibility = "public",
> extends Pipeable {
  readonly [TypeId]: typeof TypeId;
  readonly kind: "query";
  readonly visibility: TVisibility;
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
  TVisibility extends Visibility = "public",
> extends Pipeable {
  readonly [TypeId]: typeof TypeId;
  readonly kind: "mutator";
  readonly visibility: TVisibility;
  readonly name: Name;
  readonly request: Request;
  readonly mutator: (options: {
    readonly args: Schema.Schema.Type<Request>;
    readonly ctx: TContext;
    readonly tx: Transaction<TSchema, TWrappedTransaction>;
  }) => Promise<void>;
}

export type AnyQuery = QueryEndpoint<any, any, any, any, any, any, any, any>;
export type AnyMutator = MutatorEndpoint<any, any, any, any, any, any>;
export type Any = AnyQuery | AnyMutator;

export type VisibleName<
  Endpoint extends Any,
  SelectedVisibility extends Visibility,
  SelectedKind extends Any["kind"] = Any["kind"],
> = Endpoint extends Any
  ? Endpoint["visibility"] extends SelectedVisibility
    ? Endpoint["kind"] extends SelectedKind
      ? Endpoint["name"]
      : never
    : never
  : never;

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

interface QueryOptions<
  Request extends Schema.Top,
  Success extends Schema.Top,
  TTable extends keyof TSchema["tables"] & string,
  TSchema extends ZeroSchema,
  TReturn,
  TContext,
> {
  readonly request: Request;
  readonly success: Success;
  readonly runOptions?: RunOptions | undefined;
  readonly query: (options: {
    readonly args: Schema.Schema.Type<Request>;
    readonly ctx: TContext;
  }) => Query<TTable, TSchema, TReturn>;
}

export function query<
  const Name extends string,
  Request extends Schema.Top,
  Success extends Schema.Top,
  TSchema extends ZeroSchema,
  TTable extends keyof TSchema["tables"] & string,
  TReturn,
  TContext = unknown,
>(
  name: Name,
  options: QueryOptions<Request, Success, TTable, TSchema, TReturn, TContext> & {
    readonly visibility?: undefined;
  },
): QueryEndpoint<Name, Request, Success, TTable, TSchema, TReturn, TContext, "public">;
export function query<
  const Name extends string,
  Request extends Schema.Top,
  Success extends Schema.Top,
  TSchema extends ZeroSchema,
  TTable extends keyof TSchema["tables"] & string,
  TReturn,
  TContext = unknown,
  const TVisibility extends Visibility = Visibility,
>(
  name: Name,
  options: QueryOptions<Request, Success, TTable, TSchema, TReturn, TContext> & {
    readonly visibility: TVisibility;
  },
): QueryEndpoint<Name, Request, Success, TTable, TSchema, TReturn, TContext, TVisibility>;
export function query(name: string, options: any): AnyQuery {
  return make({
    kind: "query",
    visibility: options.visibility ?? "public",
    name,
    request: options.request,
    success: options.success,
    runOptions: options.runOptions,
    query: options.query,
  }) as AnyQuery;
}

interface MutatorOptions<
  Request extends Schema.Top,
  TSchema extends ZeroSchema,
  TContext,
  TWrappedTransaction,
> {
  readonly request: Request;
  readonly mutator: (options: {
    readonly args: Schema.Schema.Type<Request>;
    readonly ctx: TContext;
    readonly tx: Transaction<TSchema, TWrappedTransaction>;
  }) => Promise<void>;
}

export function mutator<
  const Name extends string,
  Request extends Schema.Top,
  TSchema extends ZeroSchema = DefaultSchema,
  TContext = unknown,
  TWrappedTransaction = unknown,
>(
  name: Name,
  options: MutatorOptions<Request, TSchema, TContext, TWrappedTransaction> & {
    readonly visibility?: undefined;
  },
): MutatorEndpoint<Name, Request, TSchema, TContext, TWrappedTransaction, "public">;
export function mutator<
  const Name extends string,
  Request extends Schema.Top,
  TSchema extends ZeroSchema = DefaultSchema,
  TContext = unknown,
  TWrappedTransaction = unknown,
  const TVisibility extends Visibility = Visibility,
>(
  name: Name,
  options: MutatorOptions<Request, TSchema, TContext, TWrappedTransaction> & {
    readonly visibility: TVisibility;
  },
): MutatorEndpoint<Name, Request, TSchema, TContext, TWrappedTransaction, TVisibility>;
export function mutator(name: string, options: any): AnyMutator {
  return make({
    kind: "mutator",
    visibility: options.visibility ?? "public",
    name,
    request: options.request,
    mutator: options.mutator,
  }) as AnyMutator;
}

export const isZeroApiEndpoint = (input: unknown): input is Any =>
  Predicate.hasProperty(input, TypeId);

export const isKind =
  <K extends Kind>(kind: K) =>
  (endpoint: Any): endpoint is Extract<Any, { readonly kind: K }> =>
    Predicate.hasProperty("kind")(endpoint) && endpoint.kind === kind;

export const isVisible = (endpoint: Any, visibilities: readonly Visibility[] | undefined) =>
  Predicate.isUndefined(visibilities)
    ? endpoint.visibility === "public"
    : visibilities.includes(endpoint.visibility);

export type RequestType<Endpoint extends Any> = Endpoint extends
  | QueryEndpoint<any, infer Request, any, any, any, any, any, any>
  | MutatorEndpoint<any, infer Request, any, any, any, any>
  ? Schema.Schema.Type<Request>
  : never;

export type RequestEncoded<Endpoint extends Any> = Endpoint extends
  | QueryEndpoint<any, infer Request, any, any, any, any, any, any>
  | MutatorEndpoint<any, infer Request, any, any, any, any>
  ? Request["Encoded"] & ReadonlyJSONValue
  : never;

export type SuccessType<Endpoint extends Any> =
  Endpoint extends QueryEndpoint<any, any, infer Success, any, any, any, any, any>
    ? Schema.Schema.Type<Success>
    : never;

export type QueryRequest<Endpoint extends AnyQuery> =
  Endpoint extends QueryEndpoint<
    any,
    any,
    any,
    infer TTable,
    infer TSchema,
    infer TReturn,
    infer TContext,
    any
  >
    ? import("@rocicorp/zero").QueryOrQueryRequest<
        TTable,
        RequestEncoded<Endpoint>,
        RequestType<Endpoint> & ReadonlyJSONValue,
        TSchema,
        TReturn,
        TContext
      >
    : never;
