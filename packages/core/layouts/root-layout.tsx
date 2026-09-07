import { ErrorBoundary } from "@karrio/ui/core/components/error-boudaries";
import { Toaster } from "@karrio/ui/components/ui/toaster";
import { PublicEnvScript } from "next-runtime-env";

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <PublicEnvScript />
        <meta charSet="utf-8" />
        <link rel="favicon" sizes="180x180" href={`/favicon.ico`} />
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          href={`/apple-touch-icon.png`}
        />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href={`/favicon-32x32.png`}
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href={`/favicon-16x16.png`}
        />
        <link rel="manifest" href={`/manifest.json`} />
        <link rel="mask-icon" href={`/safari-pinned-tab.svg`} color="#9504af" />
        <meta name="msapplication-TileColor" content="#9504af" />
        <meta name="theme-color" content="#9504af" />
        <meta name="robots" content="NONE,NOARCHIVE" />
        <meta name="theme-color" content="#9504af" />
        <link rel="manifest" href={`/manifest.json`} />
        {/* PostHog (session replay + autocapture) for the internal dashboard.
            Gated on the real deployment hostnames so local dev and embeds
            send nothing; same project as the ERP desk, split by `host`. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function () {
  var TOKEN = "__POSTHOG_PROJECT_TOKEN__";
  var HOSTS = ["karrio-app.bamboi.eu", "stage-karrio-app.bamboi.eu"];
  if (TOKEN.indexOf("phc_") !== 0) return;
  if (HOSTS.indexOf(window.location.hostname) === -1) return;
  var s = document.createElement("script");
  s.src = "https://eu-assets.i.posthog.com/static/array.js";
  s.async = true;
  s.onload = function () {
    window.posthog.init(TOKEN, {
      api_host: "https://eu.i.posthog.com",
      ui_host: "https://eu.posthog.com",
      person_profiles: "identified_only",
      session_recording: { maskAllInputs: true },
    });
    window.posthog.register({ host: window.location.hostname, app: "karrio-dashboard" });
  };
  document.head.appendChild(s);
})();`,
          }}
        />
      </head>
      <body suppressHydrationWarning>
        <noscript>You need to enable JavaScript to run this app.</noscript>

        <div id="root" style={{ minHeight: "100vh" }}>
          <ErrorBoundary>
            {children}
            <Toaster />
          </ErrorBoundary>
        </div>
      </body>
    </html>
  );
}
