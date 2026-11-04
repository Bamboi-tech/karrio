import { loadRequestMetadata } from "@karrio/core/components/metadata";
import { getCurrentDomain, loadSystemUsage } from "@karrio/core/context/main";
import { requestSession } from "@karrio/core/context/auth";
import { Metadata } from "@karrio/types";
import DashboardPage from "./index";

/**
 * Server entry for the dashboard home. Fetches the default usage range
 * during SSR (in parallel with the dashboard layout's own loaders) and
 * hands it to the client module, so the stat cards are in the first HTML.
 */
export default async function Page() {
  const session = await requestSession();
  const domain = await getCurrentDomain();
  const { metadata } = await loadRequestMetadata(domain!);
  const { prefetch } = await loadSystemUsage(
    session,
    metadata as Metadata,
    domain!,
  );

  return <DashboardPage initialUsage={prefetch} />;
}
