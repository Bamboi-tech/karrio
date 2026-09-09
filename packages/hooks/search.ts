import { SEARCH_DATA, search_data, search_dataVariables } from "@karrio/types";
import { gqlstr, isNone, onError } from "@karrio/lib";
import { useAuthenticatedQuery } from "./karrio";
import { useKarrio } from "./karrio";
import { useState, useEffect } from "react";

export function useSearch() {
  const karrio = useKarrio();
  const [filter, setFilter] = useState<search_dataVariables>({});
  const [debouncedFilter, setDebouncedFilter] = useState<search_dataVariables>({});

  const keyword = filter.keyword?.trim() || "";
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedFilter({ keyword }), 250);
    return () => clearTimeout(timer);
  }, [keyword]);

  // Queries
  const query = useAuthenticatedQuery({
    queryKey: ['search', debouncedFilter],
    queryFn: () => (
      karrio.graphql.request<search_data>(gqlstr(SEARCH_DATA), { variables: { ...debouncedFilter } })
        .then((data) => {
          const results = [
            ...(data?.order_results?.edges || []),
            ...(data?.trackers_results?.edges || []),
            ...(data?.shipment_results?.edges || []),
          ]
            .map((item: any) => item.node)
            .sort((i1, i2) => {
              return (new Date(i2.created_at as string) as any) - (new Date(i1.created_at as string) as any)
            });
          return { results };
        })
    ),
    enabled: !isNone(debouncedFilter?.keyword) && (debouncedFilter?.keyword?.length || 0) >= 2, // Only search with 2+ characters
    staleTime: 30000, // Cache results for 30 seconds
    cacheTime: 300000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: false, // Don't refetch on window focus
    retry: 1, // Only retry once on failure
    onError,
  });

  return {
    query,
    filter,
    setFilter,
    isPending: keyword.length >= 2 && (keyword !== debouncedFilter.keyword || query.isFetching),
    isCurrent: keyword === debouncedFilter.keyword,
    // Suggest removing one accidentally repeated final digit; never silently substitute an ID.
    suggestion: /^\d{4,}(\d)\1$/.test(keyword) ? keyword.slice(0, -1) : undefined,
  };
}
