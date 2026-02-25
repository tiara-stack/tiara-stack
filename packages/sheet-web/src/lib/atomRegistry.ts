import { Registry, scheduleTask } from "@effect-atom/atom-react";
import { createIsomorphicFn } from "@tanstack/react-start";

const atomRegistryScheduleTask = createIsomorphicFn()
  .server((callback: () => void) => setTimeout(callback, 0))
  .client(scheduleTask);

export const atomRegistry = Registry.make({
  scheduleTask: atomRegistryScheduleTask,
  defaultIdleTTL: 400,
});
