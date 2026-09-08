import CopyWebpackPlugin from "copy-webpack-plugin";
import { withSentryConfig } from "@sentry/nextjs";
import bundleAnalyzer from "@next/bundle-analyzer";
import { readdirSync, statSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

// Function to discover app assets at build time (synchronous)
function discoverAppAssets() {
  const patterns = [];
  const appStoreAppsPath = path.resolve(__dirname, "../../packages/app-store/apps");

  try {
    const apps = readdirSync(appStoreAppsPath);

    for (const app of apps) {
      const appPath = path.join(appStoreAppsPath, app);

      try {
        const appStat = statSync(appPath);

        if (appStat.isDirectory()) {
          // 1. Copy assets/ subdirectory if it exists
          const assetsPath = path.join(appPath, "assets");

          try {
            const assetsStat = statSync(assetsPath);
            if (assetsStat.isDirectory()) {
              patterns.push({
                from: assetsPath,
                to: path.resolve(__dirname, "public", "app-assets", app),
                globOptions: {
                  ignore: ["**/.DS_Store", "**/Thumbs.db"],
                },
              });
            }
          } catch (e) {
            // Assets directory doesn't exist for this app, skip
          }

          // 2. Copy root-level asset files (README.md, etc.)
          const rootAssetFiles = ["README.md", "CHANGELOG.md", "LICENSE"];
          for (const fileName of rootAssetFiles) {
            const rootFilePath = path.join(appPath, fileName);
            try {
              const rootFileStat = statSync(rootFilePath);
              if (rootFileStat.isFile()) {
                patterns.push({
                  from: rootFilePath,
                  to: path.resolve(__dirname, "public", "app-assets", app, fileName),
                });
              }
            } catch (e) {
              // Root file doesn't exist, skip
            }
          }
        }
      } catch (e) {
        // App directory issue, skip
      }
    }
  } catch (e) {
    console.warn("Could not discover app assets:", e.message);
  }

  return patterns;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),
  basePath: BASE_PATH,
  reactStrictMode: true,
  // Strip console.* (except error/warn) from production bundles.
  compiler: {
    removeConsole:
      process.env.NODE_ENV === "production" ? { exclude: ["error", "warn"] } : false,
  },
  experimental: {
    // Rewrite barrel imports to direct file imports so only the icons/functions
    // actually used are bundled (all three are deps of packages/ui).
    optimizePackageImports: ["lucide-react", "date-fns", "@radix-ui/react-icons"],
  },
  transpilePackages: [
    "@karrio/core",
    "@karrio/hooks",
    "@karrio/ui",
    "@karrio/lib",
    "@karrio/types",
    "@karrio/admin",
    "@karrio/developers",
    "@karrio/app-store",
  ],
  sassOptions: {
    includePaths: [
      path.join("src", "styles"),
      path.resolve(__dirname, "../../node_modules"),
    ],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none';",
          },
        ],
      },
    ];
  },
  webpack: (config, { isServer, dev }) => {
    config.resolve.fallback = { fs: false, net: false, tls: false };
    config.externals.push("pino-pretty", "encoding");

    // Copy assets during both development and production on the server side
    if (isServer) {
      const assetPatterns = discoverAppAssets();

      if (assetPatterns.length > 0) {
        config.plugins.push(
          new CopyWebpackPlugin({
            patterns: assetPatterns,
          })
        );

        console.log(`📦 Copying assets for ${assetPatterns.length} apps to static directory`);
      }
    }

    return config;
  },
};

// Source-map upload needs SENTRY_AUTH_TOKEN; without it the Sentry webpack
// plugin still generates and rewrites maps for every chunk, which is pure
// build time. Disable that work when the token is absent.
const SENTRY_UPLOAD_ENABLED = !!process.env.SENTRY_AUTH_TOKEN;

const sentryWebpackPluginOptions = {
  silent: !process.env.CI,
  disableLogger: true,
  widenClientFileUpload: false,
  sourcemaps: { disable: !SENTRY_UPLOAD_ENABLED },
  telemetry: false,
};

// `ANALYZE=true npm run build` writes .next/analyze/{client,nodejs,edge}.html
const withBundleAnalyzer = bundleAnalyzer({ enabled: process.env.ANALYZE === "true" });

export default withSentryConfig(withBundleAnalyzer(nextConfig), sentryWebpackPluginOptions);
