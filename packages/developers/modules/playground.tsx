"use client";
import React from "react";

// swagger-ui-react (~800 KB) and its stylesheet are only pulled in when the
// playground is actually rendered; `React.lazy` (not `next/dynamic`) because
// this module is also bundled by Vite for `@karrio/elements`.
const PlaygroundUI = React.lazy(() => import("./playground-ui"));

export function PlaygroundModule() {
  return (
    <React.Suspense
      fallback={
        <div className="flex items-center justify-center h-full">
          <div className="text-muted-foreground">Loading API Playground...</div>
        </div>
      }
    >
      <PlaygroundUI />
    </React.Suspense>
  );
}
