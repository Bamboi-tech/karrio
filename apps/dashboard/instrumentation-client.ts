// This file configures the initialization of Sentry on the browser.
// The config you add here will be used whenever a page is visited.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { env } from "next-runtime-env";

// Read through next-runtime-env (window.__ENV, injected by PublicEnvScript in
// the root layout): plain process.env.* is only inlined into the client bundle
// for values present at BUILD time, and our images are built without secrets —
// the DSN must come from the container's runtime environment.
const SENTRY_DSN = env("NEXT_PUBLIC_SENTRY_DSN");
const API_URL = env("NEXT_PUBLIC_KARRIO_PUBLIC_URL");

Sentry.init({
  dsn: SENTRY_DSN,
  environment: env("NEXT_PUBLIC_SENTRY_ENVIRONMENT") || "production",
  // Adjust this value in production, or use tracesSampler for greater control
  tracesSampleRate: 1.0,
  // ...
  // Note: if you want to override the automatic release value, do not set a
  // `release` value here - use the environment variable `SENTRY_RELEASE`, so
  // that it will also get attached to your source maps
  initialScope: (scope) => {
    scope.setTags({
      API: API_URL,
    });
    return scope;
  },
});

// Export the required hook for Sentry navigation instrumentation
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
