import { Predicate } from "effect";
import { clientArgsFrom } from "./sheetBotProxy";

export const sheetApisRpcArgsFromHttpArgs = (args: Record<string, unknown>) => {
  const clientArgs = clientArgsFrom(args);
  if (
    Predicate.isObject(clientArgs) &&
    Predicate.hasProperty(clientArgs, "params") &&
    !Predicate.hasProperty(clientArgs, "query") &&
    !Predicate.hasProperty(clientArgs, "payload")
  ) {
    return { query: clientArgs.params };
  }

  return clientArgs;
};
