import { Registry, RegistryContext } from "@effect-atom/atom-react";
import { HeadContent, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { TooltipProvider } from "#/components/ui/tooltip";
import { Button } from "#/components/ui/button";
import { Effect } from "effect";
import { sessionDataAtom } from "#/lib/auth";

import Header from "../components/Header";
import { Background } from "../components/Background";

import appCss from "../styles.css?url";
import { atomRegistry } from "#/lib/atomRegistry";

interface RouterContext {
  atomRegistry: Registry.Registry;
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
  loader: async ({ context }) => {
    await Effect.runPromise(
      Registry.getResult(context.atomRegistry, sessionDataAtom).pipe(
        Effect.catchAll(() => Effect.succeedNone),
      ),
    );
  },
  errorComponent: RootErrorComponent,
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
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="bg-[#0a0f0e]">
        <TooltipProvider>
          <RegistryContext.Provider value={atomRegistry}>
            <Background />
            <Header />
            {children}
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
          </RegistryContext.Provider>
        </TooltipProvider>
      </body>
    </html>
  );
}
