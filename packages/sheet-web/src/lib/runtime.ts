import { Atom } from "@effect-atom/atom-react";
import { Layer, ConfigProvider } from "effect";

// Create a config layer from import.meta.env
export const EnvConfigLive = Layer.setConfigProvider(
  ConfigProvider.fromMap(new Map(Object.entries(import.meta.env))),
);

// Create the runtime atom
export const runtimeAtom = Atom.runtime(EnvConfigLive);
