import {
  GET_ORGANIZATION,
  get_organization,
  get_organization_organization_usage
} from "@karrio/types/graphql/ee";
import {
  GET_SYSTEM_USAGE,
  GetSystemUsage,
  GetSystemUsage_system_usage,
  UsageFilter,
} from "@karrio/types";
import {
  DEFAULT_USAGE_RANGE,
  USAGE_RANGE_DAYS,
  gqlstr,
  insertUrlParam,
  isNoneOrEmpty,
  usageFilterFor,
} from "@karrio/lib";
import { useKarrio, useAuthenticatedQuery } from "./karrio";
import { useAPIMetadata } from "./api-metadata";
import { useSyncedSession } from "./session";
import moment from "moment";
import React from "react";

type UsageType = GetSystemUsage_system_usage &
  get_organization_organization_usage;
type FilterType = UsageFilter & {
  setVariablesToURL?: boolean;
  /** Usage for the default range, fetched by the server page so the stat
   *  cards are in the HTML; the client only fetches on a range change. */
  initialUsage?: GetSystemUsage_system_usage | null;
};
const USAGE_FILTERS: Record<string, UsageFilter> = Object.fromEntries(
  Object.keys(USAGE_RANGE_DAYS).map((range) => [range, usageFilterFor(range)]),
);
const DAYS_LIST: Record<string, string[]> = {
  "7 days": Array.from(Array(7))
    .map((_, i) => i)
    .reverse()
    .map((i) => moment().subtract(i, "days").format("MMM D")),
  "15 days": Array.from(Array(15))
    .map((_, i) => i)
    .reverse()
    .map((i) => moment().subtract(i, "days").format("MMM D")),
  "Last 30 days": Array.from(Array(30))
    .map((_, i) => i)
    .reverse()
    .map((i) => moment().subtract(i, "days").format("MMM D")),
  "Last 3 months": Array.from(Array(90))
    .map((_, i) => i)
    .reverse()
    .map((i) => moment().subtract(i, "days").format("MMM D")),
  "Last 6 months": Array.from(Array(180))
    .map((_, i) => i)
    .reverse()
    .map((i) => moment().subtract(i, "days").format("MMM D")),
  "Last year": Array.from(Array(360))
    .map((_, i) => i)
    .reverse()
    .map((i) => moment().subtract(i, "days").format("MMM D")),
};

export function useAPIUsage({
  setVariablesToURL = false,
  initialUsage,
  ...initialData
}: FilterType = {}) {
  const karrio = useKarrio();
  const { metadata } = useAPIMetadata();
  const { query: sessionQuery } = useSyncedSession();
  const session = sessionQuery.data;
  const [filter, _setFilter] = React.useState<UsageFilter>({
    ...USAGE_FILTERS[DEFAULT_USAGE_RANGE],
    ...initialData,
  });
  const isDefaultRange =
    filter.date_after === USAGE_FILTERS[DEFAULT_USAGE_RANGE].date_after &&
    filter.date_before === USAGE_FILTERS[DEFAULT_USAGE_RANGE].date_before;

  const systemUsage = () =>
    karrio.graphql
      .request<GetSystemUsage>(gqlstr(GET_SYSTEM_USAGE), {
        variables: { filter },
      })
      .then(({ system_usage }) => ({ usage: system_usage as UsageType }));

  const orgUsage = () =>
    karrio.graphql
      .request<get_organization>(gqlstr(GET_ORGANIZATION), {
        variables: { id: session?.orgId, usage: filter },
      })
      .then(({ organization }) => ({ usage: organization?.usage as UsageType }))
      .catch((e) => {
        // Gracefully fallback so dashboard still loads if org context is missing
        if ((e as any)?.response?.errors?.[0]?.code === "authentication_required" ||
          /No active organization/i.test((e as any)?.response?.errors?.[0]?.message || "")) {
          return systemUsage();
        }
        throw e;
      });

  const query = useAuthenticatedQuery({
    queryKey: ["usage", filter],
    queryFn: metadata.MULTI_ORGANIZATIONS == true ? orgUsage : systemUsage,
    // Only the default range is prefetched; any other key must fetch.
    initialData:
      isDefaultRange && !!initialUsage
        ? { usage: initialUsage as UsageType }
        : undefined,
    staleTime: 1500000,
    enabled: metadata.MULTI_ORGANIZATIONS ? !!session?.orgId : true,
    retry: (failureCount, error) => {
      // Don't retry if it's an authentication error
      if ((error as any)?.response?.errors?.[0]?.code === "authentication_required") {
        return false;
      }
      return failureCount < 3;
    },
  });

  function setFilter(options: UsageFilter) {
    const params = Object.keys(options).reduce((acc, key) => {
      if (["modal", "tab"].includes(key)) return acc;
      return isNoneOrEmpty(options[key as keyof UsageFilter])
        ? acc
        : {
          ...acc,
          [key]: options[key as keyof UsageFilter],
        };
    }, {});

    if (setVariablesToURL) insertUrlParam(params);
    _setFilter(params);

    return params;
  }

  return {
    query,
    filter,
    setFilter,
    DAYS_LIST,
    USAGE_FILTERS,
    currentFilter: () =>
      Object.keys(USAGE_FILTERS).find(
        (range) =>
          USAGE_FILTERS[range].date_before == filter.date_before &&
          USAGE_FILTERS[range].date_after == filter.date_after,
      ),
  };
}
