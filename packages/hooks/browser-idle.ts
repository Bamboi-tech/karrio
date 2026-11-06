import { onIdle } from "@karrio/lib";
import React from "react";

// Whether the browser has had an idle moment since the page's scripts
// started. One flag for the whole page: every subscriber shares the single
// requestIdleCallback, and once it has fired nothing is deferred any more
// (an in-app navigation later on mounts with it already true). Queries that
// are not needed for a page's first paint — connections for avatar colours,
// feature flags that have identical client-side defaults, document
// templates behind a menu — wait on it, so a page that arrives with its
// rows in the HTML is not followed by a burst of requests at hydration.
const IDLE_DEADLINE_MS = 1500;

let idle = false;
let scheduled = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!idle && !scheduled) {
    scheduled = true;
    onIdle(() => {
      idle = true;
      listeners.forEach((notify) => notify());
    }, IDLE_DEADLINE_MS);
  }
  return () => {
    listeners.delete(listener);
  };
}

export function useBrowserIdle(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => idle,
    () => false,
  );
}
