import type { Effect, Layer } from "effect";
import type { HttpRouter } from "effect/unstable/http";

type IsUnknown<T> = unknown extends T ? ([keyof T] extends [never] ? true : false) : false;

type NormalizeUnknownRequest<RequestServices, ExcludedServices, R> =
  R extends HttpRouter.Request<infer Kind, infer T>
    ? IsUnknown<T> extends true
      ? HttpRouter.Request.From<Kind, RequestServices>
      : [T] extends [ExcludedServices]
        ? never
        : R
    : R;

type NormalizeLayerUnknownRequest<RequestServices, ExcludedServices, LayerValue> =
  LayerValue extends Layer.Layer<infer ROut, infer E, infer RIn>
    ? Layer.Layer<ROut, E, NormalizeUnknownRequest<RequestServices, ExcludedServices, RIn>>
    : never;

export const withKnownRequestServices = <RequestServices, ExcludedServices = never>() =>
  function adapt<LayerValue>(
    layer: LayerValue,
  ): NormalizeLayerUnknownRequest<RequestServices, ExcludedServices, LayerValue> {
    return layer as unknown as NormalizeLayerUnknownRequest<
      RequestServices,
      ExcludedServices,
      LayerValue
    >;
  };

type EffectHandler = (argument: never) => Effect.Effect<unknown, unknown, unknown>;
type HandlerTable<Table> = {
  readonly [Key in keyof Table]: Table[Key] extends EffectHandler ? Table[Key] : never;
};
type HandlerArgument<Handler> = Handler extends (
  argument: infer Argument,
) => Effect.Effect<infer _A, infer _E, infer _R>
  ? Argument
  : never;
type HandlerSuccess<Handler> = Handler extends (
  argument: never,
) => Effect.Effect<infer A, infer _E, infer _R>
  ? A
  : never;
type HandlerError<Handler> = Handler extends (
  argument: never,
) => Effect.Effect<infer _A, infer E, infer _R>
  ? E
  : never;
type HandlerRequirements<Handler> = Handler extends (
  argument: never,
) => Effect.Effect<infer _A, infer _E, infer R>
  ? R
  : never;

export const adaptTableHandlerArgument = <Table, Key extends keyof Table>(
  _table: Table,
  _key: Key,
  argument: unknown,
): HandlerArgument<HandlerTable<Table>[Key]> =>
  argument as HandlerArgument<HandlerTable<Table>[Key]>;

export const invokeTableHandler = <Table, Key extends keyof Table>(
  table: Table,
  key: Key,
  argument: HandlerArgument<HandlerTable<Table>[Key]>,
): Effect.Effect<
  HandlerSuccess<HandlerTable<Table>[Key]>,
  HandlerError<HandlerTable<Table>[Key]>,
  HandlerRequirements<HandlerTable<Table>[Key]>
> => {
  const handler = table[key] as (
    argument: HandlerArgument<HandlerTable<Table>[Key]>,
  ) => Effect.Effect<
    HandlerSuccess<HandlerTable<Table>[Key]>,
    HandlerError<HandlerTable<Table>[Key]>,
    HandlerRequirements<HandlerTable<Table>[Key]>
  >;
  return handler(argument);
};
