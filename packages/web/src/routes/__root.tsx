import { ApolloProvider, useQuery } from "@apollo/client/react";
import { createRootRoute, Outlet, redirect } from "@tanstack/react-router";
import { Suspense } from "react";

import { graphql } from "@/graphql";

import { createApolloClient } from "../apollo";
import { getToken } from "../auth/token";
import { NavHeader, NavHeaderDocument } from "../components/nav-header";
import { QuickAddFab } from "../components/quick-add-fab";
import { Spinner } from "../components/spinner";
import { Toaster } from "../components/ui/sonner";
import { TooltipProvider } from "../components/ui/tooltip";

const apolloClient = createApolloClient();

export const Route = createRootRoute({
  // Gate every route except `/login` on the presence of a local token. A
  // stale / expired token is caught by the `UNAUTHENTICATED` handler in
  // `apollo.ts`, which clears the token and bounces to `/login` — so we
  // don't need an in-render `me` probe here.
  beforeLoad: ({ location }) => {
    if (location.pathname === "/login") return;
    if (getToken() == null) {
      throw redirect({ to: "/login" });
    }
  },
  component: RootComponent,
});

export const RootDocument = graphql(
  `
    query Root {
      ...NavHeader
    }
  `,
  [NavHeaderDocument],
);

function RootComponent() {
  const { data } = useQuery(RootDocument, { client: apolloClient });
  return (
    <ApolloProvider client={apolloClient}>
      <TooltipProvider delayDuration={200}>
        <NavHeader data={data} />
        <div className="pt-8 sm:pt-10">
          <Suspense fallback={<Spinner />}>
            <Outlet />
          </Suspense>
        </div>
        <QuickAddFab />
      </TooltipProvider>
      <Toaster richColors position="bottom-right" />
    </ApolloProvider>
  );
}
