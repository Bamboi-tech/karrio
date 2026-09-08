"use client";

import { useDeveloperTools } from "@karrio/developers/context/developer-tools-context";
import dynamic from "next/dynamic";
import React from "react";

// The developer tools drawer (graphiql, playground, codemirror, charts …) is
// the heaviest client chunk in the dashboard and is closed on nearly every
// page view. Load it on the first open only, and never on the server.
const DeveloperToolsDrawer = dynamic(
  () =>
    import("@karrio/developers/components/developer-tools-drawer").then(
      (mod) => mod.DeveloperToolsDrawer,
    ),
  { ssr: false, loading: () => null },
);

export function LazyDeveloperToolsDrawer() {
  const { isOpen } = useDeveloperTools();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    if (isOpen) setMounted(true);
  }, [isOpen]);

  // Stay mounted after the first open so close/re-open animations keep working.
  return mounted ? <DeveloperToolsDrawer /> : null;
}
