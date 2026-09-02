import { Option } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";

export const resultValue = <A, E>(result: AsyncResult.AsyncResult<A, E>): A | undefined =>
  AsyncResult.isSuccess(result) ? result.value : undefined;

export const availableResultValue = <A, E>(result: AsyncResult.AsyncResult<A, E>): A | undefined =>
  Option.getOrUndefined(AsyncResult.value(result));
