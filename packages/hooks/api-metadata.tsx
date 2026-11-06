"use client";

import { Metadata, References } from "@karrio/types";
import { scopeQueryKey, useAuthenticatedQuery, useQueryScope } from "./karrio";
import { useSyncedSession } from "./session";
import {
  browserStorage, fetchReferences, onError, purgeUserReferences, readReferences,
  referencesScopeId, url$, whenIdle, whenQuiet, writeReferences,
  ReferencesEntry, ReferencesGet, ReferencesScope,
} from "@karrio/lib";
import { QueryKey, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { usePathname, useSearchParams } from "next/navigation";

type APIMeta = {
  metadata: Metadata;
  references: References;
  getHost: () => string;
};
const APIMetadata = React.createContext<APIMeta>({} as any);

const REDUCED_REFERENCE_PATHS = ["/", "/test"];

// A 304 must resolve, not reject: it means the stored copy is current.
const getReferences: ReferencesGet = (url, headers) =>
  axios
    .get<References>(url, {
      headers,
      validateStatus: (code) => (code >= 200 && code < 300) || code === 304,
    })
    .then(({ status, data, headers: responseHeaders }) => {
      const etag = responseHeaders?.etag;
      return { status, data, etag: typeof etag === "string" ? etag : null };
    });

function APIMetadataProvider({
  children,
  metadata,
  MULTI_TENANT,
  KARRIO_PUBLIC_URL,
}: {
  metadata: Metadata;
  MULTI_TENANT?: boolean;
  KARRIO_PUBLIC_URL?: string;
  children?: React.ReactNode;
}) {
  const {
    query: { data: session },
    isAuthenticated,
  } = useSyncedSession();
  const { status: sessionStatus } = useSession();
  const queryClient = useQueryClient();
  const queryScope = useQueryScope();
  const metadataHost = metadata?.HOST;
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Screens that only need carrier names and metadata get the reduced
  // reference set (~1/6 of the full one): the shipment list and the home.
  // Detail and configuration screens load the full option catalogue.
  const reduced =
    (REDUCED_REFERENCE_PATHS.includes(pathname) || pathname === "/shipments") &&
    !searchParams?.get("modal");

  const getHost = useCallback(() => {
    const host = (
      MULTI_TENANT ? metadataHost || KARRIO_PUBLIC_URL : KARRIO_PUBLIC_URL
    ) as string;

    return host;
  }, [MULTI_TENANT, metadataHost, KARRIO_PUBLIC_URL]);

  const host = getHost();
  const isEnabled = !!host && host !== "undefined";
  const accessToken = session?.accessToken;
  const user = session?.user?.email || undefined;
  const version = metadata?.VERSION;

  // Key on host + auth state (useAuthenticatedQuery appends {orgId, testMode})
  // rather than the raw access token: a token refresh must not re-download the
  // ~300 KB reference set, and a cold load with a seeded session fetches once,
  // already authenticated. Only a truly session-less page fetches unauthenticated.
  // The list needs only reduced references; detail and configuration screens load the full option set.
  const queryKey = ["references", host, isAuthenticated, reduced];
  const scopedKey = scopeQueryKey(queryKey, queryScope) as QueryKey;
  // The stored copy is keyed by everything the payload depends on; a
  // mismatch (new API version, other user, org or mode) discards it.
  const scope = useMemo<ReferencesScope>(
    () => ({
      host,
      version,
      user,
      orgId: queryScope.orgId,
      testMode: queryScope.testMode,
      authenticated: isAuthenticated,
      reduced,
    }),
    [host, version, user, queryScope, isAuthenticated, reduced],
  );
  const scopeId = referencesScopeId(scope);
  // The entry behind the query data, so a revalidation can send its ETag
  // and hand back the same object on a 304.
  const held = useRef<ReferencesEntry | null>(null);
  // Which scope may hit the network. Stays unset during hydration, so the
  // server and first client render agree and no request starts before the
  // stored copy has been checked.
  const [fetchScope, setFetchScope] = useState<string | null>(null);

  // Stale-while-revalidate: seed react-query from the stored copy right after
  // hydration, then revalidate once the page's own queries have settled and
  // the browser is idle. Without a copy the first visit fetches at once.
  useEffect(() => {
    if (!isEnabled) return;
    if (queryClient.getQueryData(scopedKey) !== undefined) {
      setFetchScope(scopeId);
      return;
    }
    const entry = readReferences(browserStorage(), scope);
    held.current = entry;
    if (!entry) {
      setFetchScope(scopeId);
      return;
    }
    queryClient.setQueryData(scopedKey, entry.data);
    return whenQuiet(queryClient, () => {
      // Mark the seeded copy stale so enabling the query revalidates it
      // exactly once per page load, whatever its age.
      queryClient.invalidateQueries({ queryKey: scopedKey, exact: true, refetchType: "none" });
      setFetchScope(scopeId);
    });
    // Runs once per scope: the query key and the store slot derive from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeId, isEnabled]);

  // The signed-in copies belong to the session: drop them once it is gone.
  useEffect(() => {
    if (sessionStatus === "unauthenticated") {
      purgeUserReferences(browserStorage());
    }
  }, [sessionStatus]);

  const {
    data: references,
    isLoading,
    error,
  } = useAuthenticatedQuery({
    queryKey,
    queryFn: async () => {
      const store = browserStorage();
      const cached = held.current?.scope === scopeId ? held.current : readReferences(store, scope);
      const entry = await fetchReferences({
        get: getReferences,
        url: url$`${host}/v1/references?reduced=${reduced}`,
        scope,
        accessToken,
        cached,
      });
      held.current = entry;
      if (entry !== cached) {
        whenIdle(() => writeReferences(store, scope, entry));
      }
      return entry.data;
    },
    // Admin config changes surface on the next navigation after 15 min (or on
    // a hard reload); they are not worth a 300 KB download on every alt-tab.
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    staleTime: 15 * 60 * 1000,
    enabled: isEnabled && fetchScope === scopeId,
    requireAuth: false,
    onError: (err) => {
      onError(err);
    },
  });

  // Merge live feature flags from references into metadata so UI reflects changes without full
  // page reload. Only override known flag keys to keep metadata shape stable.
  const mergedMetadata = useMemo(() => {
    const base = (metadata || {}) as any;
    const src = (references || {}) as any;
    const flagKeys = [
      "AUDIT_LOGGING",
      "ALLOW_SIGNUP",
      "ALLOW_ADMIN_APPROVED_SIGNUP",
      "ALLOW_MULTI_ACCOUNT",
      "ADMIN_DASHBOARD",
      "MULTI_ORGANIZATIONS",
      "ORDERS_MANAGEMENT",
      "APPS_MANAGEMENT",
      "DOCUMENTS_MANAGEMENT",
      "DATA_IMPORT_EXPORT",
      "PERSIST_SDK_TRACING",
      "WORKFLOW_MANAGEMENT",
      "SHIPPING_RULES",
      "ADVANCED_ANALYTICS",
    ];
    const overlay: Record<string, any> = {};
    flagKeys.forEach((k) => {
      if (typeof src?.[k] !== "undefined") overlay[k] = src[k];
    });
    return { ...(base || {}), ...overlay } as Metadata;
  }, [references, metadata]);

  const value = useMemo<APIMeta>(
    () => ({
      getHost,
      metadata: mergedMetadata,
      references: (references || metadata || {}) as References,
    }),
    [getHost, mergedMetadata, references, metadata],
  );

  return <APIMetadata.Provider value={value}>{children}</APIMetadata.Provider>;
}

export function useAPIMetadata() {
  return useContext(APIMetadata);
}

export default APIMetadataProvider;
