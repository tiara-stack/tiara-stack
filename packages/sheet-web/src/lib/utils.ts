import type { ClassValue } from "clsx";
import { clsx } from "clsx";
import { DateTime } from "effect";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Date utility functions

export function getCurrentTimestamp(): number {
  return DateTime.toEpochMillis(DateTime.unsafeNow());
}
