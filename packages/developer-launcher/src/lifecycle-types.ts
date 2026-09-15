import type { ComposeLifecycleObservation } from "./compose-execution";
import type { KubernetesLifecycleObservation, LifecycleObservation } from "./execution";

export type DevelopmentLifecycleObservationType =
  | LifecycleObservation
  | ComposeLifecycleObservation
  | KubernetesLifecycleObservation;
