"use client";

import { POSTHOG_HOST, POSTHOG_KEY } from "@karrio/lib";
import { useEffect } from "react";

// Single PostHog init path for every Next app in the monorepo.
//
// posthog-js (~50 KB gz) is imported lazily inside the effect so it stays out
// of the main bundle when NEXT_PUBLIC_POSTHOG_KEY is unset (the default for
// the Bamboi dashboard). Nothing in the dashboard calls `usePostHog()`, so no
// `PostHogProvider` is rendered: mounting it after the SDK resolved would
// change the tree shape and remount every child. Code that needs the client
// can `import posthog from "posthog-js"` (same singleton) once initialised.
export function NextPostHogProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (typeof window === "undefined" || !POSTHOG_KEY) return;
    let cancelled = false;

    import("posthog-js").then(({ default: posthog }) => {
      if (cancelled || posthog.__loaded) return;
      posthog.init(POSTHOG_KEY as string, {
        api_host: POSTHOG_HOST,
        capture_pageview: false,
      });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return <>{children}</>;
}
