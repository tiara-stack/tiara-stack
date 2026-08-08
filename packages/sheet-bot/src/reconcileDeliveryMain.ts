import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { dotEnvConfigProviderLayer } from "typhoon-core/config";
import { prefixedUnstorageLayer } from "./discord/cache";
import { runRecoveryCommand } from "./reconcileDelivery";

const configProviderLayer = dotEnvConfigProviderLayer().pipe(Layer.provide(NodeFileSystem.layer));

runRecoveryCommand(process.argv.slice(2)).pipe(
  Effect.tap((result) => Effect.sync(() => process.stdout.write(`${JSON.stringify(result)}\n`))),
  Effect.provide(prefixedUnstorageLayer),
  Effect.provide(configProviderLayer),
  NodeRuntime.runMain(),
);
