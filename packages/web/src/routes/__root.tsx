import {
  ApolloProvider,
  useApolloClient,
  useQuery,
} from "@apollo/client/react";
import {
  createRootRoute,
  Outlet,
  redirect,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { Suspense, useEffect } from "react";

import { createApolloClient } from "../apollo";
import { MeDocument } from "../auth/documents";
import { clearToken, getToken } from "../auth/token";
import { NavHeader } from "../components/nav-header";
import { Spinner } from "../components/spinner";
import { Toaster } from "../components/ui/sonner";
import { TooltipProvider } from "../components/ui/tooltip";

const apolloClient = createApolloClient();

export const Route = createRootRoute({
  // Gate every route except `/login` on the presence of a local token before
  // any child component mounts. Without this, the index route's `Home`
  // component (and its `useSuspenseQuery`) can mount after login faster than
  // the in-render `AuthGate` can gate it, firing logged in queries against
  // a session that hasn't yet been recognised as authenticated.
  beforeLoad: ({ location }) => {
    if (location.pathname === "/login") return;
    if (getToken() == null) {
      throw redirect({ to: "/login" });
    }
  },
  component: RootComponent,
});

function RootComponent() {
  return (
    <ApolloProvider client={apolloClient}>
      <TooltipProvider delayDuration={200}>
        <AuthGate>
          <NavHeader />
          <div className="pt-8 sm:pt-10">
            <Suspense fallback={<Spinner />}>
              <Outlet />
            </Suspense>
          </div>
        </AuthGate>
      </TooltipProvider>
      <Toaster richColors position="bottom-right" />
    </ApolloProvider>
  );
}

/**
 * Redirect to `/login` whenever there's no local token, and verify the stored
 * token on mount by calling `me`. A failed / null `me` drops the token and
 * bounces the user to `/login`; the Apollo error link catches expired tokens
 * on subsequent requests the same way.
 *
 * The `/login` route itself renders without the gate so users can always
 * reach it — we short-circuit by path.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const apollo = useApolloClient();
  const isLoginRoute = location.pathname === "/login";
  const hasToken = typeof window !== "undefined" && getToken() != null;

  const { data, loading, error } = useQuery(MeDocument, {
    skip: isLoginRoute || !hasToken,
    fetchPolicy: "network-only",
  });

  useEffect(() => {
    if (isLoginRoute) return;
    if (!hasToken) {
      void navigate({ to: "/login" });
      return;
    }
    if (!loading && (error || data?.me === null)) {
      clearToken();
      void apollo.clearStore();
      void navigate({ to: "/login" });
    }
  }, [isLoginRoute, hasToken, loading, error, data, navigate, apollo]);

  if (isLoginRoute) return <>{children}</>;
  if (!hasToken || loading || !data?.me) return <Spinner />;
  return <>{children}</>;
}
