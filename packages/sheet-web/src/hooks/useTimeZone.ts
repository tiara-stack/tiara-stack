import { useSyncExternalStore } from "react";

const SERVER_TZ = "UTC";

const subscribe = () => () => {};

const getServerSnapshot = () => SERVER_TZ;

const getClientSnapshot = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Get the client's timezone in a SSR-safe way.
 * Returns "UTC" during SSR/hydration to avoid hydration mismatches,
 * then switches to the actual client timezone after hydration.
 */
export const useTimeZone = () => {
  return useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
};
