"use client";

import { Metadata, References } from "@karrio/types";
import { useAuthenticatedQuery } from "./karrio";
import { useSyncedSession } from "./session";
import { onError, url$ } from "@karrio/lib";
import React, { useCallback, useContext, useMemo } from "react";
import axios from "axios";

type APIMeta = {
  metadata: Metadata;
  references: References;
  getHost: () => string;
};
const APIMetadata = React.createContext<APIMeta>({} as any);

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
  const metadataHost = metadata?.HOST;

  const getHost = useCallback(() => {
    const host = (
      MULTI_TENANT ? metadataHost || KARRIO_PUBLIC_URL : KARRIO_PUBLIC_URL
    ) as string;

    return host;
  }, [MULTI_TENANT, metadataHost, KARRIO_PUBLIC_URL]);

  const host = getHost();
  const isEnabled = !!host && host !== "undefined";
  const accessToken = session?.accessToken;

  // Key on host + auth state (useAuthenticatedQuery appends {orgId, testMode})
  // rather than the raw access token: a token refresh must not re-download the
  // ~300 KB reference set, and a cold load with a seeded session fetches once,
  // already authenticated. Only a truly session-less page fetches unauthenticated.
  // `reduced=false` stays: the carrier-connection screens need the full option set.
  const {
    data: references,
    isLoading,
    error,
  } = useAuthenticatedQuery({
    queryKey: ["references", host, isAuthenticated],
    queryFn: () => {
      return axios
        .get<References>(
          url$`${host}/v1/references?reduced=false`,
          !!accessToken
            ? {
                headers: { authorization: `Bearer ${accessToken}` },
              }
            : {},
        )
        .then(({ data }) => {
          return data;
        })
        .catch((err) => {
          throw err;
        });
    },
    // Admin config changes surface on the next navigation after 15 min (or on
    // a hard reload); they are not worth a 300 KB download on every alt-tab.
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    staleTime: 15 * 60 * 1000,
    enabled: isEnabled,
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
