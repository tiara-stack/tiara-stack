import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { Registry } from "@effect-atom/atom-react";

export function getRouter() {
  const atomRegistry = Registry.make();

  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    context: {
      atomRegistry,
    },
  });

  return router;
}
