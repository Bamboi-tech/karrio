import { loadMetadata, getCurrentDomain } from "@karrio/core/context/main";
import { Metadata, ResolvingMetadata } from "next";
import { PageProps } from "@karrio/types";
import { cache } from "react";

/**
 * Request-deduplicated metadata loader.
 *
 * `loadMetadata` is already an `unstable_cache` (60s) entry, but the dashboard
 * layout and every page's `generateMetadata` both ask for it during one
 * request. React `cache` makes the second call share the first promise.
 */
export const loadRequestMetadata = cache(async (domain: string) => {
  return await loadMetadata(domain);
});

export function dynamicMetadata(pageName: string) {
  return async (
    pageProps: PageProps,
    parent: ResolvingMetadata,
  ): Promise<Metadata> => {
    const domain = await getCurrentDomain();
    const { metadata } = await loadRequestMetadata(domain!);

    return {
      title: `${pageName} - ${metadata?.APP_NAME || "Karrio"}`,
    };
  };
}
