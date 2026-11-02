import {
  GET_ORGANIZATION,
  get_organization,
  get_organization_organization_usage
} from "@karrio/types/graphql/ee";
import {
  GET_DASHBOARD_USAGE,
  GET_SYSTEM_USAGE,
  GetSystemUsage,
  GetSystemUsage_system_usage,
  UsageFilter,
  UsagePrefetch,
} from "@karrio/types";
import {
  DEFAULT_USAGE_RANGE,
  USAGE_RANGE_DAYS,
  gqlstr,
  insertUrlParam,
  isNoneOrEmpty,
  usageDayLabels,
  usageFilterFor,
  usageRangeOf,
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
  /** Usage for the default range fetched by the server page, with the exact
   *  window it was fetched for: the cards are in the HTML and the hydrated
   *  client renders that same window instead of fetching again. */
  initialUsage?: UsagePrefetch | null;
  /** "dashboard" selects only the four home series; the API computes and
   *  caches nothing else. Default: every series (developer activity view). */
  series?: "dashboard" | "all";
};

// Built per mount, not at module load: the dashboard's Node process lives for
// days, and module-level dates would freeze on the server (stale labels and
// a hydration mismatch after midnight).
function buildUsageFilters(): Record<string, UsageFilter> {
  return Object.fromEntries(
    Object.keys(USAGE_RANGE_DAYS).map((range) => [range, usageFilterFor(range)]),
  );
}

function buildDaysList(): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(USAGE_RANGE_DAYS).map(([range, days]) => [
      range,
      Array.from({ length: days }, (_, index) =>
        moment().subtract(days - 1 - index, "days").format("MMM D"),
      ),
    ]),
  );
}

export function useAPIUsage({
  setVariablesToURL = false,
  initialUsage,
  series = "all",
  ...initialData
}: FilterType = {}) {
  const karrio = useKarrio();
  const { metadata } = useAPIMetadata();
  const { query: sessionQuery } = useSyncedSession();
  const session = sessionQuery.data;
  const USAGE_FILTERS = React.useMemo(buildUsageFilters, []);
  const DAYS_LIST = React.useMemo(buildDaysList, []);
  const [filter, _setFilter] = React.useState<UsageFilter>(
    () =>
      initialUsage?.filter ?? {
        ...USAGE_FILTERS[DEFAULT_USAGE_RANGE],
        ...initialData,
      },
  );
  const currentRange = usageRangeOf(filter);
  // UTC day labels for the window actually queried; see usageDayLabel.
  const dayLabels = React.useMemo(
    () => usageDayLabels(filter),
    [filter.date_after, filter.date_before],
  );

  const systemUsage = () =>
    karrio.graphql
      .request<GetSystemUsage>(
        gqlstr(series === "dashboard" ? GET_DASHBOARD_USAGE : GET_SYSTEM_USAGE),
        { variables: { filter } },
      )
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
    queryKey: ["usage", series, filter],
    queryFn: metadata.MULTI_ORGANIZATIONS == true ? orgUsage : systemUsage,
    // The prefetched window is the initial filter, so the seed lands on that
    // key only; a range change creates a new key and fetches. The fetch time
    // travels with the seed so a stale server response refetches on mount.
    initialData:
      !!initialUsage && filter === initialUsage.filter
        ? { usage: initialUsage.usage as UsageType }
        : undefined,
    initialDataUpdatedAt: initialUsage?.fetchedAt,
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
    dayLabels,
    currentFilter: () => currentRange,
  };
}
