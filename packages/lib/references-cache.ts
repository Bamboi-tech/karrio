import type { References } from "@karrio/types";

/**
 * Stale-while-revalidate storage for `/v1/references`.
 *
 * The dashboard keeps the last payload and its `ETag` in localStorage, seeds
 * react-query from it right after hydration (no network round trip on the
 * page's critical path) and revalidates in the background with
 * `If-None-Match`, so an unchanged payload costs a 304 without a body.
 *
 * Every storage access is wrapped: a private window, a full quota or a
 * corrupt entry degrades to the plain fetch the dashboard always did.
 */

export const REFERENCES_STORAGE_PREFIX = "karrio:references:v1";

/** Everything the payload depends on. A mismatch discards the stored copy. */
export type ReferencesScope = {
  host: string;
  /** API version from the server-rendered metadata; a deploy drops the copy. */
  version?: string;
  user?: string;
  orgId?: string;
  testMode?: boolean;
  authenticated: boolean;
  reduced: boolean;
};

export type ReferencesEntry = {
  scope: string;
  /** As exposed by the API; `null` when CORS hides it (plain refetch). */
  etag: string | null;
  data: References;
};

export type ReferencesStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type ReferencesResponse = {
  status: number;
  data?: References;
  etag?: string | null;
};

export type ReferencesGet = (
  url: string,
  headers: Record<string, string>,
) => Promise<ReferencesResponse>;

export function referencesScopeId(scope: ReferencesScope): string {
  return JSON.stringify([
    scope.host,
    scope.version || "",
    scope.authenticated ? scope.user || "" : "",
    scope.orgId || "",
    !!scope.testMode,
    scope.authenticated,
    scope.reduced,
  ]);
}

/** One slot per variant bounds storage to four entries. */
export function referencesSlot(
  scope: Pick<ReferencesScope, "authenticated" | "reduced">,
): string {
  const owner = scope.authenticated ? "user" : "anon";
  const variant = scope.reduced ? "reduced" : "full";
  return `${REFERENCES_STORAGE_PREFIX}:${owner}:${variant}`;
}

export function browserStorage(): ReferencesStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readReferences(
  store: ReferencesStore | null,
  scope: ReferencesScope,
): ReferencesEntry | null {
  if (!store) return null;
  const slot = referencesSlot(scope);
  try {
    const raw = store.getItem(slot);
    if (!raw) return null;
    const entry = JSON.parse(raw) as Partial<ReferencesEntry>;
    const valid =
      entry?.scope === referencesScopeId(scope) &&
      typeof entry.data === "object" &&
      entry.data !== null;
    if (valid) {
      return {
        scope: entry.scope as string,
        etag: typeof entry.etag === "string" ? entry.etag : null,
        data: entry.data as References,
      };
    }
  } catch {
    /* Unreadable storage or a corrupt entry: fetch as usual. */
  }
  try {
    store.removeItem(slot);
  } catch {
    /* Nothing to clean up without storage. */
  }
  return null;
}

export function writeReferences(
  store: ReferencesStore | null,
  scope: ReferencesScope,
  entry: ReferencesEntry,
): boolean {
  if (!store) return false;
  const slot = referencesSlot(scope);
  try {
    store.setItem(slot, JSON.stringify(entry));
    return true;
  } catch {
    /* Quota or private mode: never leave a half-written entry behind. */
    try {
      store.removeItem(slot);
    } catch {
      /* Nothing to clean up without storage. */
    }
    return false;
  }
}

/** Drop the signed-in copies, e.g. once the session is gone. */
export function purgeUserReferences(store: ReferencesStore | null): void {
  if (!store) return;
  for (const reduced of [true, false]) {
    try {
      store.removeItem(referencesSlot({ authenticated: true, reduced }));
    } catch {
      /* Nothing to purge without storage. */
    }
  }
}

/**
 * Fetch the references, conditionally when a stored copy exists. A 304
 * returns the stored entry itself, so consumers keep the same object. A
 * conditional request that fails before any response (a proxy or CORS
 * setup that rejects `If-None-Match`) is retried once unconditionally.
 */
export async function fetchReferences({
  get,
  url,
  scope,
  accessToken,
  cached,
}: {
  get: ReferencesGet;
  url: string;
  scope: ReferencesScope;
  accessToken?: string;
  cached: ReferencesEntry | null;
}): Promise<ReferencesEntry> {
  const headers: Record<string, string> = accessToken
    ? { authorization: `Bearer ${accessToken}` }
    : {};
  const validator = cached?.etag || null;

  const request = async (conditional: boolean) => {
    const response = await get(
      url,
      conditional && validator
        ? { ...headers, "If-None-Match": validator }
        : headers,
    );
    if (response.status === 304 && cached && conditional) return cached;
    if (response.status === 304) return request(false);
    return {
      scope: referencesScopeId(scope),
      etag: response.etag || null,
      data: response.data as References,
    };
  };

  try {
    return await request(true);
  } catch (error: unknown) {
    const response = (error as { response?: unknown } | null)?.response;
    if (validator && response == null) return request(false);
    throw error;
  }
}

export type FetchTracker = {
  isFetching(): number;
  getQueryCache(): { subscribe(listener: () => void): () => void };
};

/**
 * Run `callback` once the page's own queries have settled (or `maxWait`
 * elapsed) and the browser is idle. Returns a cancel function.
 */
export function whenQuiet(
  client: FetchTracker,
  callback: () => void,
  maxWait = 5000,
): () => void {
  let done = false;
  let cancelIdle = () => {};
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;

  const settled = () => {
    if (done) return;
    done = true;
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
    cancelIdle = whenIdle(callback);
  };

  if (client.isFetching() === 0) {
    settled();
  } else {
    unsubscribe = client.getQueryCache().subscribe(() => {
      if (client.isFetching() === 0) settled();
    });
    timer = setTimeout(settled, maxWait);
  }

  return () => {
    done = true;
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
    cancelIdle();
  };
}

export function whenIdle(callback: () => void, timeout = 2000): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(callback, { timeout });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(callback, 50);
  return () => clearTimeout(handle);
}
