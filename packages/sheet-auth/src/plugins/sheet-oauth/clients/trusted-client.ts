import { Predicate } from "effect";
import type { SheetOAuthEndpointContext, SheetOAuthOptions } from "../types";
import { dedupeAsync } from "./dedupe-async";

const TrustedClientCacheTtlMs = 30_000;
const TrustedClientCacheMaxSize = 1_000;

interface TrustedClientCacheEntry {
  readonly expiresAt: number;
  readonly trusted: boolean;
}

const trustedClientCaches = new WeakMap<object, Map<string, TrustedClientCacheEntry>>();
const trustedClientLookups = new WeakMap<object, Map<string, Promise<boolean>>>();

const pruneTrustedClientCache = (cache: Map<string, TrustedClientCacheEntry>, now: number) => {
  for (const [clientId, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(clientId);
    }
  }
  while (cache.size >= TrustedClientCacheMaxSize) {
    const oldestClientId = cache.keys().next().value;
    if (!Predicate.isString(oldestClientId)) {
      break;
    }
    cache.delete(oldestClientId);
  }
};

const getTrustedClientCache = (adapter: unknown) => {
  if (!Predicate.isObject(adapter)) {
    return undefined;
  }

  const existing = trustedClientCaches.get(adapter);
  if (existing) {
    return existing;
  }

  const created = new Map<string, TrustedClientCacheEntry>();
  trustedClientCaches.set(adapter, created);
  return created;
};

const getTrustedClientLookups = (adapter: object) => {
  const existing = trustedClientLookups.get(adapter);
  if (existing) {
    return existing;
  }
  const created = new Map<string, Promise<boolean>>();
  trustedClientLookups.set(adapter, created);
  return created;
};

const parseMetadata = (metadata: unknown) => {
  if (Predicate.isString(metadata)) {
    try {
      return JSON.parse(metadata) as unknown;
    } catch {
      return undefined;
    }
  }

  return metadata;
};

const isTrustedMetadata = (metadata: unknown) => {
  const parsedMetadata = parseMetadata(metadata);
  return Predicate.hasProperty(parsedMetadata, "trusted") && parsedMetadata.trusted === true;
};

export const isTrustedClient = async (
  ctx: SheetOAuthEndpointContext,
  clientId: string | undefined,
  options: SheetOAuthOptions,
) => {
  if (!clientId) {
    return false;
  }

  if (options.trustedClientIds?.has(clientId)) {
    return true;
  }

  const adapter = ctx.context.adapter;
  const cache = getTrustedClientCache(adapter);
  const now = Date.now();
  const cached = cache?.get(clientId);
  if (cached && cached.expiresAt > now) {
    return cached.trusted;
  }
  cache?.delete(clientId);

  const lookups = Predicate.isObject(adapter) ? getTrustedClientLookups(adapter) : undefined;
  const lookup = async () => {
    const client = await adapter.findOne({
      model: "oauthClient",
      where: [{ field: "clientId", value: clientId }],
    });
    const trusted = isTrustedMetadata(client?.metadata);
    if (cache) {
      pruneTrustedClientCache(cache, Date.now());
    }
    cache?.set(clientId, {
      expiresAt: Date.now() + TrustedClientCacheTtlMs,
      trusted,
    });
    return trusted;
  };
  return lookups ? await dedupeAsync(lookups, clientId, lookup) : await lookup();
};
