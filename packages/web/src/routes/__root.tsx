import { ApolloProvider } from "@apollo/client/react";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { Suspense } from "react";

import { createApolloClient } from "../apollo";
import { Spinner } from "../components/spinner";
import { Toaster } from "../components/ui/sonner";
import { TooltipProvider } from "../components/ui/tooltip";

const apolloClient = createApolloClient();

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <ApolloProvider client={apolloClient}>
      <TooltipProvider delayDuration={200}>
        <Suspense fallback={<Spinner />}>
          <Outlet />
        </Suspense>
      </TooltipProvider>
      <Toaster richColors position="bottom-right" />
    </ApolloProvider>
  );
}
