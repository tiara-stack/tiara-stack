import { Predicate } from "effect";
import { clientArgsFrom } from "./sheetBotProxy";

type ClientArgsFromHttpArgs<Args extends Record<string, unknown>> =
  Omit<Args, "request" | "endpoint" | "group"> extends infer ClientArgs extends Record<
    string,
    unknown
  >
    ? keyof ClientArgs extends never
      ? undefined
      : "params" extends keyof ClientArgs
        ? "query" extends keyof ClientArgs
          ? ClientArgs
          : "payload" extends keyof ClientArgs
            ? ClientArgs
            : Omit<ClientArgs, "params"> & { readonly query: ClientArgs["params"] }
        : ClientArgs
    : never;

export const sheetApisRpcArgsFromHttpArgs = <const Args extends Record<string, unknown>>(
  args: Args,
): ClientArgsFromHttpArgs<Args> => {
  const clientArgs = clientArgsFrom(args);
  const result =
    Predicate.isObject(clientArgs) &&
    Predicate.hasProperty(clientArgs, "params") &&
    !Predicate.hasProperty(clientArgs, "query") &&
    !Predicate.hasProperty(clientArgs, "payload")
      ? { query: clientArgs.params }
      : clientArgs;

  return result as unknown as ClientArgsFromHttpArgs<Args>;
};
