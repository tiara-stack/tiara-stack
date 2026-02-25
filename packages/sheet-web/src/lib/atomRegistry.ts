import { Registry, scheduleTask } from "@effect-atom/atom-react";

export const atomRegistry = Registry.make({ scheduleTask, defaultIdleTTL: 400 });
