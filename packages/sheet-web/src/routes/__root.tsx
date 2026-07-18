import { AtomRegistry } from "effect/unstable/reactivity";
import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
  useRouterState,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { MotionConfig } from "motion/react";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import { TooltipProvider } from "#/components/ui/tooltip";
import { Button } from "#/components/ui/button";
import { MeilisearchSearchDialog } from "#/components/docs/search-dialog";

import Header from "../components/Header";
import { Background } from "../components/Background";

import appCss from "../styles.css?url";
import { Effect } from "effect";
import { ensureResultAtomData } from "#/lib/atomRegistry";
import { sessionAtom } from "#/lib/auth";

interface RouterContext {
  atomRegistry: AtomRegistry.AtomRegistry;
}

// Error fallback component for root route
function RootErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0f0e] text-white p-8">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold mb-4 text-[#ff6b6b]">Something went wrong</h1>
        <p className="text-white/60 mb-6">
          {error.message || "An unexpected error occurred. Please try again."}
        </p>
        <Button onClick={reset} className="bg-[#33ccbb] hover:bg-[#2db8a8] text-[#0a0f0e]">
          Try Again
        </Button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "SheetWeb - Discord Schedule Management",
      },
      {
        name: "description",
        content: "Track filling and monitoring schedules for your Discord servers.",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  loader: async ({ context, location }) => {
    if (location.pathname === "/docs" || location.pathname.startsWith("/docs/")) return;

    console.log("loading session");
    await Effect.runPromise(ensureResultAtomData(context.atomRegistry, sessionAtom));
    console.log("session loaded");
  },
  shellComponent: RootDocument,
  errorComponent: RootErrorComponent,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  const isDocsRoute = useRouterState({
    select: (state) =>
      state.location.pathname === "/docs" || state.location.pathname.startsWith("/docs/"),
  });

  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className={isDocsRoute ? "docs-shell bg-[#0a0f0e]" : "bg-[#0a0f0e]"}>
        <RootProvider
          theme={{ enabled: false }}
          search={{
            SearchDialog: MeilisearchSearchDialog,
            links: [
              ["TiaraBot overview", "/docs/tiarabot"],
              ["When TiaraBot pings", "/docs/tiarabot/quick-reference/pings-and-actions"],
            ],
          }}
        >
          <TooltipProvider>
            <MotionConfig reducedMotion="user">
              {!isDocsRoute && <Background />}
              {!isDocsRoute && <Header />}
              {children}
            </MotionConfig>
            <TanStackDevtools
              config={{
                position: "bottom-right",
              }}
              plugins={[
                {
                  name: "Tanstack Router",
                  render: <TanStackRouterDevtoolsPanel />,
                },
              ]}
            />
            <Scripts />
          </TooltipProvider>
        </RootProvider>
      </body>
    </html>
  );
}
