import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupStartAtomIntegration } from "start-atom";
import { routeTree } from "./routeTree.gen";
import { makeAtomRegistry } from "#/lib/atomRegistry";

export function getRouter() {
  const atomRegistry = makeAtomRegistry();

  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    context: {
      atomRegistry,
    },
  });

  if (import.meta.env.VITE_ENABLE_COMMAND_OBSERVE_PROTOTYPE !== "true") {
    setupStartAtomIntegration({
      router,
      registry: atomRegistry,
    });
  }

  return router;
}
