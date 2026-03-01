import { useSyncExternalStore } from "react";
import { DateTime } from "effect";
import { createIsomorphicFn } from "@tanstack/react-start";

const subscribe = () => () => {};

export const getServerTimeZone = () => DateTime.zoneUnsafeMakeNamed("UTC");

export const getClientTimeZone = () => DateTime.zoneMakeLocal();

export const getTimeZone = createIsomorphicFn().server(getServerTimeZone).client(getClientTimeZone);

/**
 * Get the client's timezone in a SSR-safe way.
 * Returns UTC timezone during SSR/hydration to avoid hydration mismatches,
 * then switches to the actual client timezone after hydration.
 */
export const useTimeZone = () => {
  return useSyncExternalStore(subscribe, getClientTimeZone, getServerTimeZone);
};
