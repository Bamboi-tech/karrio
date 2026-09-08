"use client";

import {
  SessionType,
  KarrioClient,
  Metadata,
  UserType,
  GetWorkspaceConfig_workspace_config,
} from "@karrio/types";
import {
  useQuery,
  useMutation,
  UseQueryOptions,
  UseMutationOptions,
} from "@tanstack/react-query";
import { get_organizations_organizations } from "@karrio/types/graphql/ee";
import { getCookie, KARRIO_API, logger, url$ } from "@karrio/lib";
import { useAPIMetadata } from "@karrio/hooks/api-metadata";
import { useSyncedSession } from "@karrio/hooks/session";
import React from "react";

logger.debug("API clients initialized for Server: " + KARRIO_API);

type ClientProviderProps = {
  children?: React.ReactNode;
};

interface ExtendedSessionType {
  accessToken?: string;
  testMode?: boolean;
  orgId?: string;
  error?: string;
}

type APIClientsContextProps = KarrioClient & {
  isAuthenticated: boolean;
  pageData?: {
    orgId?: string;
    user?: UserType;
    pathname?: string;
    metadata?: Metadata;
    organizations?: get_organizations_organizations[];
    workspace_config?: GetWorkspaceConfig_workspace_config;
  };
};

const defaultClient = new KarrioClient({ basePath: url$`${KARRIO_API || ""}` });

export const APIClientsContext = React.createContext<APIClientsContextProps>({
  ...defaultClient,
  isAuthenticated: false,
  pageData: {},
});

/**
 * Keep the same object reference while every own property is `===` equal.
 * Used for the rest-spread `pageData` so the context value can be memoized.
 */
function useShallowStable<T extends Record<string, any>>(value: T): T {
  const ref = React.useRef<T>(value);
  const prev = ref.current;
  const same =
    prev === value ||
    (Object.keys(prev).length === Object.keys(value).length &&
      Object.keys(value).every((k) => prev[k] === value[k]));
  if (!same) ref.current = value;
  return same ? prev : value;
}

export const ClientProvider = ({
  children,
  ...pageData
}: ClientProviderProps): JSX.Element => {
  const { getHost } = useAPIMetadata();
  const { query: sessionQuery, isAuthenticated } = useSyncedSession();
  const session = sessionQuery.data as ExtendedSessionType;
  const stablePageData = useShallowStable(pageData);

  const host = getHost?.() || KARRIO_API || "";

  // Use a ref to always have the latest session for the interceptor.
  // Initialised from the (seeded) session so the very first requests already
  // carry the auth header; kept current synchronously so child effects that
  // fire before this component's own effects never see a stale token.
  const sessionRef = React.useRef<ExtendedSessionType | undefined>(session);
  sessionRef.current = session;

  // Memoize client setup to avoid recreating on every render
  // but use sessionRef in interceptor to always get latest session
  const client = React.useMemo(() => {
    const karrioClient = new KarrioClient({ basePath: url$`${host}` });
    karrioClient.axios.interceptors.request.use(
      (config: any = { headers: {} }) => {
        const currentSession = sessionRef.current;
        const cookieOrgId = getCookie("orgId");
        const testHeader: any = !!currentSession?.testMode
          ? { "x-test-mode": currentSession.testMode }
          : {};
        const authHeader: any = !!currentSession?.accessToken
          ? { authorization: `Bearer ${currentSession.accessToken}` }
          : {};
        const orgHeader: any = !!currentSession?.orgId
          ? { "x-org-id": currentSession.orgId }
          : {};

        config.headers = {
          ...config.headers,
          ...authHeader,
          ...orgHeader,
          ...testHeader,
        };

        return config;
      },
    );
    return karrioClient;
  }, [host]);

  const value = React.useMemo<APIClientsContextProps>(
    () => ({
      ...client,
      isAuthenticated,
      pageData: stablePageData,
    }),
    [client, isAuthenticated, stablePageData],
  );

  return (
    <APIClientsContext.Provider value={value}>
      {children}
    </APIClientsContext.Provider>
  );
};

export function useKarrio() {
  return React.useContext(APIClientsContext);
}

/** Cache scope appended to every authenticated query key. */
export type QueryScope = { orgId?: string; testMode?: boolean };

/**
 * Append the `{ orgId, testMode }` scope `useAuthenticatedQuery` uses, so
 * manual cache writes (prefetchQuery / setQueryData / getQueryData) land on
 * the same key the hook reads.
 */
export function scopeQueryKey(key: unknown, scope: QueryScope): unknown {
  if (key == null) return key;
  const keyArray = Array.isArray(key) ? key : [key];
  return [...keyArray, { orgId: scope.orgId, testMode: scope.testMode }];
}

/** The current session's cache scope (memoized). */
export function useQueryScope(): QueryScope {
  const { query: sessionQuery } = useSyncedSession();
  const orgId = (sessionQuery.data as any)?.orgId as string | undefined;
  const testMode = (sessionQuery.data as any)?.testMode as boolean | undefined;
  return React.useMemo(() => ({ orgId, testMode }), [orgId, testMode]);
}

/** `scopeQueryKey` bound to the current session scope. */
export function useScopedQueryKey<TKey = unknown>(key: TKey): TKey {
  const scope = useQueryScope();
  return React.useMemo(() => scopeQueryKey(key, scope) as TKey, [key, scope]);
}

// Utility hook for authentication-aware queries
export function useAuthenticatedQuery<
  TQueryFnData = unknown,
  TError = unknown,
  TData = TQueryFnData,
>(
  options: Omit<UseQueryOptions<TQueryFnData, TError, TData>, "enabled"> & {
    enabled?: boolean;
    requireAuth?: boolean;
  },
) {
  const { isAuthenticated } = useKarrio();
  const { query: sessionQuery } = useSyncedSession();
  const scope = useQueryScope();
  const { requireAuth = true, enabled = true, ...queryOptions } = options;

  // Wait for session to be fully loaded with data before enabling authenticated queries
  // isAuthenticated already checks for accessToken presence, so this ensures data is ready
  const sessionReady =
    isAuthenticated && !!(sessionQuery.data as any)?.accessToken;
  const shouldEnable = requireAuth ? enabled && sessionReady : enabled;

  // Scope query keys by orgId and testMode to avoid cross-org cache bleed
  const scopedKey = scopeQueryKey((queryOptions as any).queryKey, scope);

  return useQuery({
    ...queryOptions,
    queryKey: scopedKey as any,
    enabled: shouldEnable,
    retry: (failureCount, error) => {
      // Don't retry if it's an authentication error
      if (
        (error as any)?.response?.errors?.[0]?.code ===
          "authentication_required" ||
        (error as any)?.errors?.[0]?.extensions?.code === "UNAUTHENTICATED" ||
        (error as any)?.message?.includes("authentication")
      ) {
        return false;
      }
      return failureCount < 1;
    },
  });
}

// Utility hook for authentication-aware mutations
export function useAuthenticatedMutation<
  TData = unknown,
  TError = unknown,
  TVariables = void,
  TContext = unknown,
>(options: UseMutationOptions<TData, TError, TVariables, TContext>) {
  return useMutation(options);
}
