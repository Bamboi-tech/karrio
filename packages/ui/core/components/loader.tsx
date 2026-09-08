import React, { useCallback, useMemo, useState } from "react";

interface LoadingNotifier {
  loading: boolean;
  setLoading: (loading: boolean) => void;
}

interface LoadingProviderComponent {
  children: React.ReactNode;
}

const HIDE_DELAY_MS = 150;

export const Loading = React.createContext<LoadingNotifier>(
  {} as LoadingNotifier,
);

export const LoadingProvider = ({
  children,
}: LoadingProviderComponent): JSX.Element => {
  const [loading, changeLoading] = useState<boolean>(false);

  // Show immediately; hide after a short grace period so back-to-back fetches
  // don't flicker. (Was 2000 ms: every fetch showed the bar for fetch + 2 s.)
  const setLoading = useCallback((loading: boolean) => {
    setTimeout(
      () => {
        changeLoading(loading);
      },
      loading ? 0 : HIDE_DELAY_MS,
    );
  }, []);

  const value = useMemo(() => ({ loading, setLoading }), [loading, setLoading]);

  return (
    <Loading.Provider value={value}>
      {loading && (
        <progress className="progress is-primary karrio-loader" max="100">
          50%
        </progress>
      )}
      {children}
    </Loading.Provider>
  );
};

export function useLoader() {
  return React.useContext(Loading);
}
