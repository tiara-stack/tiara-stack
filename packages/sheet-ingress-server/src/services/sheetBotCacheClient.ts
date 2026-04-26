import { Context, Effect, Layer, Option, Redacted } from "effect";
import { HttpClient } from "effect/unstable/http";
import { config } from "@/config";
import { SheetApisClient } from "./sheetApisClient";

export interface CachedGuildMember {
  readonly roles: ReadonlyArray<string>;
}

export interface CachedGuildRole {
  readonly id: string;
  readonly permissions: string;
}

const makeTargetUrl = (baseUrl: string, path: string) =>
  new URL(path.replace(/^\/+/, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const decodeMember = (json: unknown): Option.Option<CachedGuildMember> => {
  if (!isRecord(json) || !isRecord(json.value) || !Array.isArray(json.value.roles)) {
    return Option.none();
  }

  const roles = json.value.roles.filter((role): role is string => typeof role === "string");
  return Option.some({ roles });
};

const decodeRoles = (json: unknown): ReadonlyMap<string, CachedGuildRole> => {
  if (!Array.isArray(json)) {
    return new Map();
  }

  const roles = json.flatMap((entry): CachedGuildRole[] => {
    if (
      !isRecord(entry) ||
      !isRecord(entry.value) ||
      typeof entry.value.id !== "string" ||
      typeof entry.value.permissions !== "string"
    ) {
      return [];
    }

    return [{ id: entry.value.id, permissions: entry.value.permissions }];
  });

  return new Map(roles.map((role) => [role.id, role]));
};

export class SheetBotCacheClient extends Context.Service<SheetBotCacheClient>()(
  "SheetBotCacheClient",
  {
    make: Effect.gen(function* () {
      const baseUrl = yield* config.sheetBotBaseUrl;
      const sheetApisClient = yield* SheetApisClient;
      const httpClient = yield* HttpClient.HttpClient;

      const fetchJson = Effect.fn("SheetBotCacheClient.fetchJson")(function* (path: string) {
        const serviceUser = yield* sheetApisClient.getServiceUser();
        const response = yield* httpClient.get(makeTargetUrl(baseUrl, path), {
          headers: {
            Authorization: `Bearer ${Redacted.value(serviceUser.token)}`,
          },
        });

        if (response.status === 404) {
          return Option.none<unknown>();
        }
        if (response.status < 200 || response.status >= 300) {
          return yield* Effect.fail(
            new Error(`Sheet bot cache request failed: ${response.status}`),
          );
        }

        return Option.some(yield* response.json);
      });

      return {
        getMember: Effect.fn("SheetBotCacheClient.getMember")(function* (
          guildId: string,
          accountId: string,
        ) {
          const json = yield* fetchJson(
            `/cache/members/${encodeURIComponent(guildId)}/${encodeURIComponent(accountId)}`,
          );
          return Option.flatMap(json, decodeMember);
        }),
        getRolesForGuild: Effect.fn("SheetBotCacheClient.getRolesForGuild")(function* (
          guildId: string,
        ) {
          const json = yield* fetchJson(`/cache/roles/${encodeURIComponent(guildId)}`);
          return Option.match(json, {
            onNone: () => new Map<string, CachedGuildRole>(),
            onSome: decodeRoles,
          });
        }),
      };
    }),
  },
) {
  static layer = Layer.effect(SheetBotCacheClient, this.make).pipe(
    Layer.provide(SheetApisClient.layer),
  );
}
