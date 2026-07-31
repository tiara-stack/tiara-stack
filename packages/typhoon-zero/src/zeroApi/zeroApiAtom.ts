import { Atom } from "effect/unstable/reactivity";
import { Match, Predicate } from "effect";
import type { Cause, Stream } from "effect";
import type { AsyncResult } from "effect/unstable/reactivity";
import type * as ZeroApi from "./zeroApi";
import type * as ZeroApiClient from "./zeroApiClient";
import type * as ZeroApiEndpoint from "./zeroApiEndpoint";
import type * as ZeroFunctionReference from "./zeroFunctionReference";
import type { OptionalArgs } from "./zeroApiClientTypes";

const NoArgs = Symbol("ZeroApiAtom.NoArgs");

interface ErasedFunctionClient {
  readonly stream: (
    reference: ZeroFunctionReference.AnyQueryReference,
    ...args: readonly unknown[]
  ) => Stream.Stream<unknown, unknown>;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Predicate.isObject(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

const stringifyRecord = (value: Record<string, unknown>) =>
  `object:{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(
      ([key, nested]) =>
        `${JSON.stringify(key)}:${
          Predicate.isUndefined(nested) ? "undefined" : stableStringify(nested)
        }`,
    )
    .join(",")}}`;

const unsupportedArgument = (value: unknown): never => {
  const type = Predicate.isFunction(value)
    ? "function"
    : Predicate.isSymbol(value)
      ? "symbol"
      : Object.prototype.toString.call(value);
  throw new TypeError(`Unsupported Zero atom argument type "${type}"`);
};

const stableStringify = (value: unknown): string =>
  Match.value(value).pipe(
    Match.when(Predicate.isNull, () => "null"),
    Match.when(Predicate.isUndefined, unsupportedArgument),
    Match.when(Predicate.isString, (text) => `string:${JSON.stringify(text)}`),
    Match.when(
      Predicate.isNumber,
      (number) => `number:${Object.is(number, -0) ? "-0" : String(number)}`,
    ),
    Match.when(Predicate.isBoolean, (boolean) => `boolean:${boolean}`),
    Match.when(Predicate.isBigInt, (bigint) => `bigint:${bigint}`),
    Match.when(
      Array.isArray,
      (array) =>
        `array:[${Array.from(array, (element) =>
          Predicate.isUndefined(element) ? "undefined" : stableStringify(element),
        ).join(",")}]`,
    ),
    Match.when(Predicate.isDate, (date) => `date:${JSON.stringify(date.toISOString())}`),
    Match.when(isPlainRecord, stringifyRecord),
    Match.orElse(unsupportedArgument),
  );

const makeArgumentAtoms = (
  client: ErasedFunctionClient,
  reference: ZeroFunctionReference.AnyQueryReference,
) => {
  const noArgsAtom = Atom.make(client.stream(reference));
  const entriesByKey = new Map<string, { readonly key: string; readonly argument: unknown }>();
  const atomsByEntry = Atom.family((entry: { readonly key: string; readonly argument: unknown }) =>
    Atom.make(client.stream(reference, entry.argument)),
  );
  return (arg: unknown) => {
    if (arg === NoArgs) {
      return noArgsAtom;
    }
    const key = `args:${stableStringify(arg)}`;
    const entry = entriesByKey.get(key) ?? { key, argument: arg };
    entriesByKey.set(key, entry);
    return atomsByEntry(entry);
  };
};

const queryAtoms = Atom.family((client: ErasedFunctionClient) => {
  const entriesByKey = new Map<
    string,
    {
      readonly key: string;
      readonly reference: ZeroFunctionReference.AnyQueryReference;
    }
  >();
  const atomsByReference = Atom.family(
    (entry: {
      readonly key: string;
      readonly reference: ZeroFunctionReference.AnyQueryReference;
    }) => makeArgumentAtoms(client, entry.reference),
  );
  return (reference: ZeroFunctionReference.AnyQueryReference) => {
    const key = JSON.stringify([reference.api, reference.kind, reference.group, reference.name]);
    const entry = entriesByKey.get(key) ?? { key, reference };
    entriesByKey.set(key, entry);
    return atomsByReference(entry);
  };
});

/**
 * Creates an Effect Atom backed by a materialized Zero query. Mounting the atom
 * starts the subscription and disposing it destroys the materialized view.
 */
export const makeQuery = <
  Api extends ZeroApi.Any,
  Visibility extends ZeroApiEndpoint.Visibility,
  Reference extends ZeroFunctionReference.QueryForApi<Api, Visibility>,
>(
  client: ZeroApiClient.FunctionClient<Api, Visibility>,
  reference: Reference,
  ...args: OptionalArgs<ZeroApiEndpoint.RequestType<Reference["endpoint"]>>
): Atom.Atom<
  AsyncResult.AsyncResult<
    ZeroApiEndpoint.SuccessType<Reference["endpoint"]>,
    ZeroApiClient.QueryError | Cause.NoSuchElementError
  >
> =>
  queryAtoms(client as unknown as ErasedFunctionClient)(reference)(
    args.length === 0 || args[0] === undefined ? NoArgs : args[0],
  ) as Atom.Atom<
    AsyncResult.AsyncResult<
      ZeroApiEndpoint.SuccessType<Reference["endpoint"]>,
      ZeroApiClient.QueryError | Cause.NoSuchElementError
    >
  >;
