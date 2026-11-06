import { describe, expect, it, vi } from "vitest";
import {
  fetchReferences, purgeUserReferences, readReferences, referencesScopeId, referencesSlot, whenQuiet, writeReferences,
  type ReferencesEntry, type ReferencesScope, type ReferencesStore,
} from "../../lib/references-cache";

const scope: ReferencesScope = {
  host: "https://api.example.com",
  version: "2026.1.31",
  user: "ops@example.com",
  orgId: "org_1",
  testMode: false,
  authenticated: true,
  reduced: true,
};
const data = { carriers: { dhl: "DHL" } } as any;
const entry = (overrides: Partial<ReferencesEntry> = {}): ReferencesEntry => ({
  scope: referencesScopeId(scope),
  etag: '"abc"',
  data,
  ...overrides,
});

function memoryStore(): ReferencesStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

describe("references storage", () => {
  it("round-trips an entry for its own scope", () => {
    const store = memoryStore();
    expect(writeReferences(store, scope, entry())).toBe(true);
    expect(readReferences(store, scope)).toEqual(entry());
  });

  it("discards a copy from another version, user, org or mode", () => {
    for (const change of [
      { version: "2026.2.0" },
      { user: "other@example.com" },
      { orgId: "org_2" },
      { testMode: true },
    ] as Partial<ReferencesScope>[]) {
      const store = memoryStore();
      writeReferences(store, scope, entry());
      expect(readReferences(store, { ...scope, ...change })).toBeNull();
      expect(store.items.size).toBe(0);
    }
  });

  it("keeps reduced, full, signed-in and anonymous copies apart", () => {
    const store = memoryStore();
    const full = { ...scope, reduced: false };
    const anon = { ...scope, authenticated: false, user: undefined };
    writeReferences(store, scope, entry());
    writeReferences(store, full, entry({ scope: referencesScopeId(full) }));
    writeReferences(store, anon, entry({ scope: referencesScopeId(anon) }));
    expect(store.items.size).toBe(3);
    expect(readReferences(store, full)?.scope).toBe(referencesScopeId(full));
    purgeUserReferences(store);
    expect([...store.items.keys()]).toEqual([referencesSlot(anon)]);
  });

  it("ignores a corrupt entry and a throwing store", () => {
    const store = memoryStore();
    store.setItem(referencesSlot(scope), "{not json");
    expect(readReferences(store, scope)).toBeNull();
    expect(store.items.size).toBe(0);

    const fail = () => { throw new Error("SecurityError"); };
    const broken: ReferencesStore = { getItem: fail, setItem: fail, removeItem: fail };
    expect(readReferences(broken, scope)).toBeNull();
    expect(writeReferences(broken, scope, entry())).toBe(false);
    expect(readReferences(null, scope)).toBeNull();
    expect(writeReferences(null, scope, entry())).toBe(false);
  });
});

describe("fetchReferences", () => {
  const url = "https://api.example.com/v1/references?reduced=true";

  it("sends the stored validator and keeps the same entry on a 304", async () => {
    const get = vi.fn(async () => ({ status: 304 }));
    const cached = entry();
    const result = await fetchReferences({ get, url, scope, accessToken: "t", cached });
    expect(result).toBe(cached);
    expect(get).toHaveBeenCalledWith(url, {
      authorization: "Bearer t",
      "If-None-Match": '"abc"',
    });
  });

  it("stores the new payload and ETag on a 200", async () => {
    const fresh = { carriers: { ups: "UPS" } } as any;
    const get = vi.fn(async () => ({ status: 200, data: fresh, etag: '"def"' }));
    const result = await fetchReferences({ get, url, scope, cached: entry() });
    expect(result).toEqual({ scope: referencesScopeId(scope), etag: '"def"', data: fresh });
  });

  it("fetches plainly without a copy or without an exposed ETag", async () => {
    const get = vi.fn(async () => ({ status: 200, data }));
    await fetchReferences({ get, url, scope, cached: null });
    await fetchReferences({ get, url, scope, cached: entry({ etag: null }) });
    expect(get.mock.calls.map(([, headers]) => headers)).toEqual([{}, {}]);
    expect((await fetchReferences({ get, url, scope, cached: null })).etag).toBeNull();
  });

  it("retries once unconditionally when the conditional request gets no response", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("Network Error"), { response: undefined }))
      .mockResolvedValueOnce({ status: 200, data, etag: null });
    const result = await fetchReferences({ get, url, scope, cached: entry() });
    expect(result.etag).toBeNull();
    expect(get.mock.calls[1][1]).toEqual({});

    const denied = vi.fn().mockRejectedValue({ response: { status: 429 } });
    await expect(fetchReferences({ get: denied, url, scope, cached: entry() })).rejects.toEqual({
      response: { status: 429 },
    });
    expect(denied).toHaveBeenCalledTimes(1);
  });
});

describe("whenQuiet", () => {
  function tracker(fetching: number) {
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener));
    return {
      fetching,
      listeners,
      isFetching() { return this.fetching; },
      getQueryCache: () => ({ subscribe }),
      settle() { this.fetching = 0; listeners.forEach((listener) => listener()); },
    };
  }

  it("waits for in-flight queries, then runs when idle", () => {
    vi.useFakeTimers();
    const client = tracker(2);
    const callback = vi.fn();
    whenQuiet(client, callback, 5000);
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
    client.settle();
    vi.runAllTimers();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(client.listeners.size).toBe(0);
    vi.useRealTimers();
  });

  it("gives up waiting after maxWait and can be cancelled", () => {
    vi.useFakeTimers();
    const slow = tracker(1);
    const callback = vi.fn();
    whenQuiet(slow, callback, 500);
    vi.advanceTimersByTime(600);
    expect(callback).toHaveBeenCalledTimes(1);

    const cancelled = vi.fn();
    const cancel = whenQuiet(tracker(0), cancelled);
    cancel();
    vi.runAllTimers();
    expect(cancelled).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
