import { ApolloProvider } from "@apollo/client/react";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { Suspense } from "react";

import { createApolloClient } from "../apollo";
import { Spinner } from "../components/spinner";
import { Toaster } from "../components/ui/sonner";
import { TooltipProvider } from "../components/ui/tooltip";
import appCss from "../styles.css?url";

const apolloClient = createApolloClient();

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "fire" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <ApolloProvider client={apolloClient}>
          <TooltipProvider delayDuration={200}>
            <Suspense fallback={<Spinner />}>
              <Outlet />
            </Suspense>
          </TooltipProvider>
        </ApolloProvider>
        <Toaster richColors position="top-right" />
        <Scripts />
      </body>
    </html>
  );
}
