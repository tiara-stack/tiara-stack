import { Schema } from "effect";

export const LifecyclePhase = Schema.Literals([
  "reserved",
  "provisioning",
  "migrating",
  "starting",
  "ready",
  "quarantined",
  "deleting",
  "deleted",
  "resolving",
  "fenced",
]);
export type LifecyclePhase = typeof LifecyclePhase.Type;
