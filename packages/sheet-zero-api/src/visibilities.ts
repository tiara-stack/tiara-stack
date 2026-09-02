export const publicVisibilities = ["public"] as const;
/** Trusted clients need the public read/write domain surface plus service-only workflows. */
export const serviceVisibilities = ["public", "service"] as const;
export const serverVisibilities = serviceVisibilities;
