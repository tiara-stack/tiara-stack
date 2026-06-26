import { Context, Effect, Layer } from "effect";
import type { ClientRef } from "sheet-ingress-api/schemas/client";
import { makeArgumentError } from "typhoon-core/error";
import { config } from "@/config";

type ClientRegistryEntry = {
  readonly platform: string;
  readonly clientId: string;
  readonly baseUrl: string;
  readonly serviceTokenResource: string;
};

const clientRegistryKey = (client: ClientRef): string => `${client.platform}:${client.clientId}`;

export class ClientRegistry extends Context.Service<ClientRegistry>()("ClientRegistry", {
  make: Effect.gen(function* () {
    const entries = yield* config.sheetClients;
    const byClient: ReadonlyMap<string, ClientRegistryEntry> = new Map(
      entries.map((entry) => [`${entry.platform}:${entry.clientId}`, entry] as const),
    );

    return {
      list: Effect.fn("ClientRegistry.list")(function* () {
        yield* Effect.void;
        return entries.map((entry) => ({
          platform: entry.platform,
          clientId: entry.clientId,
        }));
      }),
      resolve: Effect.fn("ClientRegistry.resolve")(function* (client: ClientRef) {
        const entry = byClient.get(clientRegistryKey(client));
        if (entry === undefined) {
          return yield* Effect.fail(
            makeArgumentError(`Unknown client ${client.platform}:${client.clientId}`),
          );
        }
        return entry;
      }),
    };
  }),
}) {
  static layer = Layer.effect(ClientRegistry, this.make);
}
