"use client";
import dynamic from "next/dynamic";
import React from "react";

// graphiql + graphiql.min.css are only fetched on /resources/graphiql.
const GraphiQLUI = dynamic(() => import("./graphiql-ui"), {
  ssr: false,
  loading: () => <div className="p-4">Loading GraphQL Explorer...</div>,
});

export default function GraphiQLPage() {
  return <GraphiQLUI />;
}
