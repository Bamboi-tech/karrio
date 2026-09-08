import { LogFilter, get_logs, GET_LOGS, get_log, GET_LOG } from "@karrio/types";
import { gqlstr, insertUrlParam, isNoneOrEmpty, onError } from "@karrio/lib";
import {
  scopeQueryKey,
  useAuthenticatedQuery,
  useKarrio,
  useQueryScope,
} from "./karrio";
import { useQueryClient } from "@tanstack/react-query";
import React from "react";

const PAGE_SIZE = 20;
const PAGINATION = { offset: 0, first: PAGE_SIZE };
type FilterType = LogFilter & {
  setVariablesToURL?: boolean;
  /** Prefetch page 2 once page 1 lands (opt-in; detail views don't page). */
  preloadNextPage?: boolean;
  /** Pass `!!entityId` from detail views to avoid querying a placeholder id. */
  enabled?: boolean;
};

export function useLogs({
  setVariablesToURL = false,
  preloadNextPage = false,
  enabled = true,
  ...initialData
}: FilterType = {}) {
  const karrio = useKarrio();
  const queryClient = useQueryClient();
  const scope = useQueryScope();
  const [filter, _setFilter] = React.useState<LogFilter>({
    ...PAGINATION,
    ...initialData,
  });
  const fetch = (variables: { filter: LogFilter }) =>
    karrio.graphql.request<get_logs>(gqlstr(GET_LOGS), { variables });

  // Queries
  const query = useAuthenticatedQuery({
    queryKey: ["logs", filter],
    queryFn: () => fetch({ filter }),
    enabled,
    keepPreviousData: true,
    staleTime: 30000,
    onError,
  });

  function setFilter(options: LogFilter) {
    const params = Object.keys(options).reduce((acc, key) => {
      if (["modal"].includes(key)) return acc;
      return isNoneOrEmpty(options[key as keyof LogFilter])
        ? acc
        : {
            ...acc,
            [key]: ["method", "status_code"].includes(key)
              ? []
                  .concat(options[key as keyof LogFilter] as any)
                  .reduce(
                    (acc, item: string) =>
                      typeof item == "string"
                        ? [].concat(acc, item.split(",") as any)
                        : [].concat(acc, item),
                    [],
                  )
              : ["offset", "first"].includes(key)
                ? parseInt(options[key as keyof LogFilter] as any)
                : options[key as keyof LogFilter],
          };
    }, PAGINATION);

    if (setVariablesToURL) insertUrlParam(params);
    _setFilter(params);

    return params;
  }

  React.useEffect(() => {
    if (preloadNextPage === false) return;
    if (query.data?.logs.page_info.has_next_page) {
      const _filter = { ...filter, offset: (filter.offset as number) + 20 };
      // Same scoped key the list reads.
      queryClient.prefetchQuery(
        scopeQueryKey(["logs", _filter], scope) as any,
        () => fetch({ filter: _filter }),
      );
    }
  }, [query.data, filter.offset, queryClient, scope, preloadNextPage]);

  return {
    query,
    filter,
    setFilter,
  };
}

export function useLog(id: string) {
  const karrio = useKarrio();

  // Queries
  const query = useAuthenticatedQuery({
    queryKey: ["logs", id],
    queryFn: () =>
      karrio.graphql.request<get_log>(gqlstr(GET_LOG), {
        variables: { id: parseInt(id) },
      }),
    enabled: !!id,
    onError,
  });

  return {
    query,
  };
}
