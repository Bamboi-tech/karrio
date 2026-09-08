"use client";

import { getSession, signOut, useSession } from "next-auth/react";
import { ServerError, ServerErrorCode } from "@karrio/lib";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import type { Session } from "next-auth";
import { useKarrio } from "./karrio";
import React from "react";

interface ExtendedSession extends Session {
  accessToken?: string;
  testMode?: boolean;
  error?: string;
  orgId?: string;
}

const SESSION_QUERY_KEY = ["session"];
// next-auth's SessionProvider already polls /api/auth/session every 300s
// (providers.tsx) and pushes the result into `useSession().data`; that data
// is mirrored into this query below, so no separate poller is needed here.
const SESSION_STALE_TIME = 5 * 60 * 1000;

const sessionChanged = (
  a?: ExtendedSession | null,
  b?: ExtendedSession | null,
) =>
  a?.accessToken !== b?.accessToken ||
  a?.orgId !== b?.orgId ||
  a?.testMode !== b?.testMode ||
  a?.error !== b?.error;

export function useSyncedSession() {
  const { data: nextSession, status } = useSession();
  const queryClient = useQueryClient();
  // The server already passed the session (with accessToken) to SessionProvider;
  // seed the query with it so authenticated queries can run on the first render
  // instead of waiting for a client round trip to /api/auth/session.
  const seed = (nextSession ?? undefined) as ExtendedSession | undefined;

  // Queries
  const query = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async () => {
      const session = await getSession();
      return session as ExtendedSession;
    },
    initialData: seed,
    enabled: status === "authenticated",
    staleTime: SESSION_STALE_TIME,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) => {
      // Don't retry if session is invalid or authentication failed
      if (
        (error as any)?.message?.includes("authentication") ||
        status === "unauthenticated"
      ) {
        return false;
      }
      return failureCount < 1;
    },
  });

  // Mirror SessionProvider updates (token refresh, org switch via
  // `update()`, sign-out) into the query so every consumer — including the
  // axios interceptor ref in ClientProvider — sees the latest token.
  React.useEffect(() => {
    if (status !== "authenticated" || !seed) return;
    const current =
      queryClient.getQueryData<ExtendedSession>(SESSION_QUERY_KEY);
    if (sessionChanged(current, seed)) {
      queryClient.setQueryData(SESSION_QUERY_KEY, seed);
    }
  }, [seed, status, queryClient]);

  return {
    query,
    isAuthenticated:
      status === "authenticated" &&
      !!(query.data as ExtendedSession)?.accessToken,
    isLoading: status === "loading" || query.isLoading,
  };
}

export const NextSession = React.createContext<{
  session: ExtendedSession | null | undefined;
  isAuthenticated: boolean;
  isLoading: boolean;
}>({
  session: undefined,
  isAuthenticated: false,
  isLoading: true,
});

const NextSessionProvider = ({
  children,
}: {
  children?: React.ReactNode;
}): JSX.Element => {
  const { data: session, status } = useSession();
  const [sessionState, setSessionState] =
    React.useState<ExtendedSession | null>(session as ExtendedSession);
  const isAuthenticated =
    status === "authenticated" && !!(session as ExtendedSession)?.accessToken;
  const isLoading = status === "loading";

  React.useEffect(() => {
    if (
      (session as ExtendedSession)?.error !==
        (sessionState as ExtendedSession)?.error ||
      (session as ExtendedSession)?.accessToken !==
        (sessionState as ExtendedSession)?.accessToken ||
      session === null
    ) {
      setSessionState(session as ExtendedSession);
    }
  }, [session, sessionState]);

  const value = React.useMemo(
    () => ({
      session: sessionState,
      isAuthenticated,
      isLoading,
    }),
    [sessionState, isAuthenticated, isLoading],
  );

  return (
    <NextSession.Provider value={value}>
      {!isLoading ? children : null}
    </NextSession.Provider>
  );
};

export const SessionWrapper = ({
  children,
  error,
}: {
  error?: ServerError;
  children?: React.ReactNode;
}): JSX.Element => {
  const karrio = useKarrio();
  const router = useRouter();
  const { data: session, status } = useSession();
  const isAuthenticated =
    status === "authenticated" &&
    !!(session as ExtendedSession)?.accessToken &&
    karrio?.isAuthenticated;

  React.useEffect(() => {
    if (
      session === null ||
      (session as ExtendedSession)?.error === "RefreshAccessTokenError" ||
      error?.code === ServerErrorCode.API_AUTH_ERROR
    ) {
      const redirectUrl =
        "/signin?next=" + window.location.pathname + window.location.search;

      if (error?.code === ServerErrorCode.API_AUTH_ERROR) {
        signOut({ callbackUrl: redirectUrl });
      } else {
        router.push(redirectUrl);
      }
    }
  }, [session, error, router]);

  return <>{isAuthenticated ? children : null}</>;
};

export default NextSessionProvider;
