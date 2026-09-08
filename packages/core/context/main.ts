"use server";
import {
  isNone,
  KARRIO_ADMIN_API_KEY,
  KARRIO_ADMIN_URL,
  KARRIO_URL,
  logger,
  MULTI_TENANT,
  ServerErrorCode,
  TENANT_ENV_KEY,
  url$,
} from "@karrio/lib";
import { AccountContextDataType, Metadata, TenantType } from "@karrio/types";
import { revalidateTag, unstable_cache } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { Session } from "next-auth";
import axios from "axios";

const AUTH_HTTP_CODES = [401, 403, 407];
const METADATA_REVALIDATE = 60;
const ACCOUNT_DATA_REVALIDATE = 60;
const ACCOUNT_DATA_TAG = "account-data";
const ORG_DATA_TAG = "org-data";

/**
 * Helper function to extract the current domain from headers
 * Use this at the top level of your page components or API routes
 * and pass the result to other functions to avoid headers() calls inside cached functions
 */
export async function getCurrentDomain(): Promise<string | null> {
  return (await headers()).get("host");
}

export async function requireAuthentication(session: Session | null) {
  const hasError = (session as any)?.error === "RefreshAccessTokenError";

  logger.debug("requireAuthentication", {
    hasSession: !!session,
    hasError,
    error: (session as any)?.error,
  });

  if (!session || hasError) {
    const [pathname, search] = [
      (await headers()).get("x-pathname") || "/",
      (await headers()).get("x-search") || "",
    ];

    if (pathname.includes("/signin")) return;

    const location = search.includes("next")
      ? `?${search}`
      : `?next=${pathname}${search}`;

    logger.info("redirecting to signin", {
      pathname,
      reason: !session ? "no session" : "token error",
    });
    redirect(`/signin${location}`);
  }
}

export async function requireOrganization(
  session: Session | null,
  metadata?: Metadata,
  org?: any,
) {
  if (!session || !metadata?.MULTI_ORGANIZATIONS) {
    logger.debug("requireOrganization: skipping", {
      hasSession: !!session,
      multiOrg: metadata?.MULTI_ORGANIZATIONS,
    });
    return;
  }

  const pathname = (await headers()).get("x-pathname") || "/";

  // Skip check if already on create-organization page
  if (pathname.includes("/create-organization")) {
    logger.debug("requireOrganization: already on create-organization page");
    return;
  }

  const organizations = org?.organizations || [];
  const hasOrgId = !!(session as any)?.orgId;

  logger.debug("requireOrganization: checking organizations", {
    count: organizations.length,
    pathname,
    hasOrgId,
    orgId: (session as any)?.orgId,
    hasError: !!org?.error,
  });

  // If user has an orgId in session but no organizations loaded, there might be a query error
  // Don't redirect in this case to avoid infinite loops
  if (!organizations.length && !hasOrgId) {
    logger.info("redirecting to create-organization", { pathname });
    redirect("/create-organization");
  }
}

// Create domain-specific cached metadata loader
function createMetadataLoader(domain?: string) {
  return unstable_cache(
    async () => {
      // Detect if we're in a build environment
      const IS_BUILD =
        process.env.NODE_ENV === "production" &&
        process.env.NEXT_PHASE === "phase-production-build";

      // Return mock data during build to avoid actual API calls
      if (IS_BUILD) {
        logger.debug({
          action: "> loadMetadata",
          message: "Using mock data during build",
        });
        return {
          metadata: {
            HOST: "http://mock-api-for-build",
            VERSION: "build-version",
            APP_NAME: "Karrio",
            APP_WEBSITE: "https://karrio.io",
            ADMIN: "http://localhost:5002/admin",
            GRAPHQL: "http://localhost:5002/graphql",
            OPENAPI: "http://localhost:5002/openapi",
            AUDIT_LOGGING: true,
            ALLOW_SIGNUP: true,
            ALLOW_ADMIN_APPROVED_SIGNUP: false,
            ALLOW_MULTI_ACCOUNT: true,
            ADMIN_DASHBOARD: true,
            MULTI_ORGANIZATIONS: true,
            ORDERS_MANAGEMENT: true,
            APPS_MANAGEMENT: true,
            DOCUMENTS_MANAGEMENT: true,
            DATA_IMPORT_EXPORT: false,
            PERSIST_SDK_TRACING: true,
            WORKFLOW_MANAGEMENT: true,
          },
          error: null,
        };
      }

      // Attempt connection to the karrio API to retrieve the API metadata
      const API_URL = await getAPIURL(undefined, domain);

      logger.debug({ action: "> loadMetadata", API_URL });

      const { data: metadata, error } = await axios
        .get<Metadata>(url$`${API_URL}`, {
          headers: { "Content-Type": "application/json" },
        })
        .then((res) => ({ data: res.data, error: null }))
        .catch((e) => {
          console.log("loadMetadata", e);
          const code = AUTH_HTTP_CODES.includes(e.response?.status)
            ? ServerErrorCode.API_AUTH_ERROR
            : ServerErrorCode.API_CONNECTION_ERROR;

          return {
            data: null,
            error: {
              code,
              message: `
              Server (${API_URL}) unreachable.
              Please make sure that the API is running and reachable.
            `,
            },
          };
        });

      return { metadata, error };
    },
    [`metadata-${domain || "default"}`],
    // 60s: admin feature-flag changes surface within a minute; 5s guaranteed a
    // cache miss (and an API round trip) on nearly every navigation.
    { revalidate: METADATA_REVALIDATE, tags: ["metadata"] },
  );
}

// Cached version of loadMetadata to prevent multiple requests during build
export async function loadMetadata(domain?: string) {
  const cachedLoader = createMetadataLoader(domain);
  return await cachedLoader();
}

/**
 * Identity used to scope the per-request account/org caches.
 * The access token is deliberately NOT part of the key (it rotates and must
 * not be persisted in the Next cache); the loaders capture it by closure.
 */
function sessionCacheScope(session: any, domain?: string) {
  const userId = session?.user?.email || session?.email || "anonymous";
  const orgId = session?.orgId || "none";
  const testMode = session?.testMode ? "test" : "live";
  return { userId, orgId, testMode, domain: domain || "default" };
}

/**
 * Run a loader through `unstable_cache` but never persist a failed result:
 * an auth error cached for 60s would sign the user out on every navigation.
 */
function withResultCache<T extends { error?: any }>(
  loader: () => Promise<T>,
  keyParts: string[],
  tags: string[],
) {
  const cached = unstable_cache(
    async () => {
      const result = await loader();
      if (result?.error) {
        const err: any = new Error("uncacheable loader result");
        err.result = result;
        throw err;
      }
      return result;
    },
    keyParts,
    { revalidate: ACCOUNT_DATA_REVALIDATE, tags },
  );

  return async (): Promise<T> => {
    try {
      return await cached();
    } catch (e: any) {
      if (e?.result) return e.result as T;
      throw e;
    }
  };
}

/**
 * Invalidate the cached account/org data (tags: `account-data`, `org-data`,
 * plus per-user `account-data:<email>` / `org-data:<email>`).
 * Call from client code after a workspace-config / organization mutation.
 */
export async function revalidateAccountData(
  scope: "account" | "org" | "all" = "all",
  userId?: string,
) {
  const tags = [
    ...(scope !== "org"
      ? [userId ? `${ACCOUNT_DATA_TAG}:${userId}` : ACCOUNT_DATA_TAG]
      : []),
    ...(scope !== "account"
      ? [userId ? `${ORG_DATA_TAG}:${userId}` : ORG_DATA_TAG]
      : []),
  ];
  tags.forEach((tag) => revalidateTag(tag, "max"));
}

export async function loadUserData(
  session: any,
  metadata?: Metadata,
  domain?: string,
) {
  if (!session || !metadata) return { user: null };

  const {
    userId,
    orgId,
    testMode,
    domain: scopeDomain,
  } = sessionCacheScope(session, domain);
  const loader = withResultCache(
    () => fetchUserData(session, metadata, domain),
    [`${ACCOUNT_DATA_TAG}-${userId}-${orgId}-${testMode}-${scopeDomain}`],
    [ACCOUNT_DATA_TAG, `${ACCOUNT_DATA_TAG}:${userId}`],
  );

  return await loader();
}

async function fetchUserData(
  session: any,
  metadata: Metadata,
  domain?: string,
) {
  const API_URL = await getAPIURL(metadata, domain);
  const { accessToken, orgId, testMode } = session;
  const { data, error } = await axios
    .post<AccountContextDataType>(
      url$`${API_URL}/graphql`,
      { query: ACCOUNT_DATA_QUERY },
      {
        headers: {
          ...(orgId ? { "x-org-id": orgId } : {}),
          ...(testMode ? { "x-test-mode": testMode } : {}),
          authorization: `Bearer ${accessToken}`,
        } as any,
      },
    )
    .then((res) => ({ data: res.data?.data, error: null }))
    .catch((e) => {
      const code = AUTH_HTTP_CODES.includes(e.response?.status)
        ? ServerErrorCode.API_AUTH_ERROR
        : ServerErrorCode.API_CONNECTION_ERROR;
      return {
        data: {},
        error: {
          code,
          message: `
          Server (${API_URL}) unreachable.
          Please make sure that the API is running and reachable.
        `,
        },
      };
    });

  return { ...data, error };
}

export async function loadOrgData(
  session: any,
  metadata?: Metadata,
  domain?: string,
) {
  if (!session || !metadata || !metadata.MULTI_ORGANIZATIONS) {
    return { organizations: [] };
  }

  const {
    userId,
    orgId,
    testMode,
    domain: scopeDomain,
  } = sessionCacheScope(session, domain);
  const loader = withResultCache(
    () => fetchOrgData(session, metadata, domain),
    [`${ORG_DATA_TAG}-${userId}-${orgId}-${testMode}-${scopeDomain}`],
    [ORG_DATA_TAG, `${ORG_DATA_TAG}:${userId}`],
  );

  return await loader();
}

async function fetchOrgData(session: any, metadata: Metadata, domain?: string) {
  const API_URL = await getAPIURL(metadata, domain);
  const { accessToken, orgId, testMode } = session;
  const { data, error } = await axios
    .post<AccountContextDataType>(
      url$`${API_URL}/graphql`,
      { query: ORG_DATA_QUERY },
      {
        headers: {
          ...(orgId ? { "x-org-id": orgId } : {}),
          ...(testMode ? { "x-test-mode": testMode } : {}),
          authorization: `Bearer ${accessToken}`,
        } as any,
      },
    )
    .then((res) => ({
      data:
        (res.data?.data as any)?.organizations?.edges?.map(
          (e: any) => e.node,
        ) || [],
      error: null,
    }))
    .catch((e) => {
      const code = AUTH_HTTP_CODES.includes(e.response?.status)
        ? ServerErrorCode.API_AUTH_ERROR
        : ServerErrorCode.API_CONNECTION_ERROR;
      return {
        data: [],
        error: {
          code,
          message: `
          Server (${API_URL}) unreachable.
          Please make sure that the API is running and reachable.
        `,
        },
      };
    });

  // Return a consistent shape for client providers
  return { organizations: data, error };
}

async function getAPIURL(metadata?: Metadata, app_domain?: string) {
  if (metadata?.HOST) {
    return MULTI_TENANT ? metadata.HOST : KARRIO_URL;
  }

  if (
    MULTI_TENANT === true &&
    !isNone(KARRIO_ADMIN_URL) &&
    !isNone(KARRIO_ADMIN_API_KEY)
  ) {
    // Use provided app_domain or get it from headers
    const domain = app_domain || ((await headers()).get("host") as string);
    const tenant =
      MULTI_TENANT && !!domain
        ? await loadTenantInfo({ app_domain: domain })
        : null;
    const APIURL = !!TENANT_ENV_KEY
      ? (tenant?.api_domains || []).find((d) =>
          d.includes(TENANT_ENV_KEY as string),
        )
      : (tenant?.api_domains || [])[0];

    return (!!APIURL ? APIURL : KARRIO_URL) as string;
  }

  return KARRIO_URL as string;
}

// Create domain-specific cached tenant info loader
function createTenantInfoLoader(domain: string) {
  return unstable_cache(
    async (): Promise<TenantType | null> => {
      logger.debug("loadTenantInfo", { app_domain: domain });
      try {
        const { data } = await axios({
          url: url$`${KARRIO_ADMIN_URL}/admin/graphql/`,
          method: "POST",
          headers: {
            authorization: `Token ${KARRIO_ADMIN_API_KEY}`,
          },
          data: {
            variables: { filter: { app_domain: domain } },
            query: TENANT_QUERY,
          },
        });
        return data.data?.tenants?.edges[0]?.node;
      } catch (e: any) {
        console.log(e);
        console.log(e.response?.data, url$`${KARRIO_ADMIN_URL}/admin/graphql/`);
        return null;
      }
    },
    [`tenant-${domain}`],
    { revalidate: 3600, tags: ["tenant"] },
  );
}

export async function loadTenantInfo(filter: {
  app_domain?: string;
  schema_name?: string;
}): Promise<TenantType | null> {
  // For app_domain, use cached loader
  if (filter.app_domain) {
    const cachedLoader = createTenantInfoLoader(filter.app_domain);
    return await cachedLoader();
  }

  // For schema_name or other filters, make direct call (less common case)
  logger.debug("loadTenantInfo (uncached)", filter);
  try {
    const { data } = await axios({
      url: url$`${KARRIO_ADMIN_URL}/admin/graphql/`,
      method: "POST",
      headers: {
        authorization: `Token ${KARRIO_ADMIN_API_KEY}`,
      },
      data: { variables: { filter }, query: TENANT_QUERY },
    });
    return data.data?.tenants?.edges[0]?.node;
  } catch (e: any) {
    console.log(e);
    console.log(e.response?.data, url$`${KARRIO_ADMIN_URL}/admin/graphql/`);
    return null;
  }
}

const ACCOUNT_DATA_QUERY = `{
  user {
    email
    full_name
    is_staff
    is_superuser
    last_login
    date_joined
    permissions
  }
  workspace_config {
    object_type
    default_currency
    default_country_code
    default_weight_unit
    default_dimension_unit
    state_tax_id
    federal_tax_id
    default_label_type
    customs_aes
    customs_eel_pfc
    customs_license_number
    customs_certificate_number
    customs_nip_number
    customs_eori_number
    customs_vat_registration_number
    insured_by_default
  }
}`;
const ORG_DATA_QUERY = `{
  organizations(filter: {is_active: true}) {
    page_info {
      count
      has_next_page
      has_previous_page
      start_cursor
      end_cursor
    }
    edges {
      node {
        id
        name
        slug
        token
        current_user {
          email
          full_name
          is_admin
          is_owner
          last_login
        }
        members {
          email
          full_name
          is_admin
          is_owner
          invitation {
            id
            guid
            invitee_identifier
            created
            modified
          }
          last_login
        }
      }
    }
  }
}`;

const TENANT_QUERY = `query getTenant($filter: TenantFilter!) {
  tenants(filter: $filter) {
    edges { node { schema_name api_domains } }
  }
}`;
