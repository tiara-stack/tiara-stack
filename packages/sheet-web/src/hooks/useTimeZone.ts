import { useSyncExternalStore } from "react";
import { DateTime } from "effect";

const subscribe = () => () => {};

export const getServerTimeZone = () => DateTime.zoneMakeNamedUnsafe("UTC");

const getClientTimeZone = () => DateTime.zoneMakeLocal();

/**
 * Get the client's timezone in a SSR-safe way.
 * Returns UTC timezone during SSR/hydration to avoid hydration mismatches,
 * then switches to the actual client timezone after hydration.
 */
export const useTimeZone = () => {
  return useSyncExternalStore(subscribe, getClientTimeZone, getServerTimeZone);
};
