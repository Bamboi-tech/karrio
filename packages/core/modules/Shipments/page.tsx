import { loadRequestMetadata } from "@karrio/core/components/metadata";
import {
  getCurrentDomain,
  loadShipmentBadgeCounts,
  loadShipmentsList,
} from "@karrio/core/context/main";
import { requestSession } from "@karrio/core/context/auth";
import {
  SHIPMENT_LIST_COOKIE,
  isFailedShipmentsView,
  parseShipmentListView,
  shipmentListFilter,
  shipmentListScope,
} from "@karrio/lib/shipment-list";
import { Metadata, ShipmentsPageSeed } from "@karrio/types";
import { cookies, headers } from "next/headers";
import ShipmentsPage from "./index";

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Server entry for the shipments board. On a document request it starts
 * the first page and the badge counts for exactly the filter the client
 * derives from the same URL and the same view cookie, and hands the
 * promises down without awaiting them: the HTML streams the skeleton first
 * and the board with its rows as soon as the API answers. An in-app
 * navigation (an RSC request, Sec-Fetch-Dest "empty") carries no seed: it
 * reads the react-query cache, warmed by the home page and the sidebar
 * link, and must never wait on a fetch the client may already have made.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const [session, domain, params, cookieStore, headerList] = await Promise.all([
    requestSession(),
    getCurrentDomain(),
    searchParams,
    cookies(),
    headers(),
  ]);
  const { metadata } = await loadRequestMetadata(domain!);
  const { orgId, testMode, user } = (session || {}) as {
    orgId?: string;
    testMode?: boolean;
    user?: { email?: string | null };
  };
  const view = parseShipmentListView(
    cookieStore.get(SHIPMENT_LIST_COOKIE)?.value,
    shipmentListScope(user?.email, orgId, testMode),
  );
  const filter = shipmentListFilter(params, view);
  const seed: ShipmentsPageSeed | null =
    headerList.get("sec-fetch-dest") === "document"
      ? {
          filter,
          scope: { orgId, testMode },
          // A timestamp is printed in the browser's zone; until the cookie
          // has told the server which one, the rows are left to the client.
          list:
            view.timeZone && !isFailedShipmentsView(filter)
              ? loadShipmentsList(session, metadata as Metadata, domain!, filter)
              : null,
          badges: loadShipmentBadgeCounts(session, metadata as Metadata, domain!),
        }
      : null;

  return <ShipmentsPage seed={seed} view={view} />;
}
