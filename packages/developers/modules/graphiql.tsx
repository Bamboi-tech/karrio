"use client";
import React from "react";

// graphiql (+ graphiql.min.css, ~270 KB gz) is only loaded when the explorer
// is rendered; `React.lazy` rather than `next/dynamic` because this module is
// also bundled by Vite for `@karrio/elements`.
const GraphiQLUI = React.lazy(() => import("./graphiql-ui"));

export function GraphiQLModule() {
  return (
    <React.Suspense
      fallback={
        <div className="flex items-center justify-center h-full">
          <div className="text-muted-foreground">
            Loading GraphQL Explorer...
          </div>
        </div>
      }
    >
      <GraphiQLUI />
    </React.Suspense>
  );
}
