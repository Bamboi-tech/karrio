import * as Sentry from "@sentry/nextjs";

// Server-side runs read the container's runtime environment directly; the
// NEXT_PUBLIC_ fallback lets one env var drive both this init and the browser
// init in instrumentation-client.ts.
const SENTRY_DSN = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;
const SENTRY_ENVIRONMENT =
  process.env.SENTRY_ENVIRONMENT ||
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ||
  "production";
const API_URL =
  process.env.KARRIO_PUBLIC_URL || process.env.NEXT_PUBLIC_KARRIO_PUBLIC_URL;

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    Sentry.init({
      dsn: SENTRY_DSN,
      environment: SENTRY_ENVIRONMENT,
      tracesSampleRate: 1.0,
      initialScope: (scope) => {
        scope.setTags({
          API: API_URL,
        });
        return scope;
      },
    });
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({
      dsn: SENTRY_DSN,
      environment: SENTRY_ENVIRONMENT,
      tracesSampleRate: 1.0,
    });
  }
}

// Captures all unhandled server-side request errors with request context
// (URL, router kind, route path) instead of a bare exception.
export const onRequestError = Sentry.captureRequestError;
