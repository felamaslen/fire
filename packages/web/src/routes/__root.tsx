import { ApolloProvider, useQuery } from "@apollo/client/react";
import { createRootRoute, Outlet, redirect } from "@tanstack/react-router";
import { Suspense } from "react";

import { graphql } from "@/graphql";

import { createApolloClient } from "../apollo";
import { getToken } from "../auth/token";
import { InvalidationsListener } from "../components/invalidations-listener";
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
      {getToken() != null && <InvalidationsListener />}
      <TooltipProvider delayDuration={200}>
        <NavHeader data={data} />
        {/* `pb-16` = the floating add button's height (h-14 = 56px) + 8px,
            so the last row of any page list isn't covered by the FAB.
            (The FAB itself sits `bottom-4` / `sm:bottom-6` above the
            viewport edge, giving an extra 8-16px of visual gap.) */}
        <div className="pt-8 pb-16 sm:pt-10">
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
