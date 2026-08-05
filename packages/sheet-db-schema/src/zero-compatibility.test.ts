import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import * as canonical from "sheet-zero-api";
import * as canonicalServer from "sheet-zero-api/server";
import type { ZeroClient } from "typhoon-zero/client";
import { vi } from "vitest";
import * as legacy from "./zero/index";
import * as legacyInternal from "./zero/internal";

describe("legacy sheet-db-schema/zero compatibility", () => {
  it("preserves canonical schema, API, reference, and registry identity", () => {
    expect(legacy.schema).toBe(canonical.schema);
    expect(legacy.api).toBe(canonical.api);
    expect(legacy.SheetZeroApi).toBe(canonicalServer.SheetZeroApi);
    expect(legacy.serviceApi).toBe(canonicalServer.serviceApi);
    expect(legacy.queries).toBe(canonicalServer.serverQueries);
    expect(legacy.mutators).toBe(canonicalServer.serverMutators);
    expect(legacy.makeSheetClient).toBe(canonicalServer.makeLegacySheetClient);
    expect(legacy.makeSheetServiceClient).toBe(canonicalServer.makeSheetServiceClient);
    expect(legacyInternal.service).toBe(canonicalServer.service);
    expect(legacyInternal.internal).toBe(canonicalServer.internal);
  });

  it.effect("keeps legacy public clients wired to the combined registry objects", () =>
    Effect.gen(function* () {
      const mutate = vi.fn<ZeroClient.ZeroClientExecutor<canonical.Schema, unknown>["mutate"]>(() =>
        Effect.succeed({
          client: () => Effect.void,
          server: () => Effect.void,
        }),
      );
      const client = yield* legacy.makeSheetClient({
        mutate,
        run: () => Effect.die("query execution is not used"),
        stream: () => Stream.die("query streaming is not used"),
      });
      const request = {
        clientPlatform: "discord",
        clientId: "client-1",
        messageId: "message-1",
        day: 1,
        workspaceId: null,
        conversationId: null,
        createdByUserId: null,
      } as const;

      yield* client.execute(legacy.api.messageSlot.upsertMessageSlotData, request);

      expect(mutate).toHaveBeenCalledOnce();
      expect(mutate.mock.calls[0]![0].mutator).toBe(
        canonicalServer.serverMutators.messageSlot.upsertMessageSlotData,
      );
      expect(mutate.mock.calls[0]![0].mutator).toBe(
        legacy.mutators.messageSlot.upsertMessageSlotData,
      );
    }),
  );
});
