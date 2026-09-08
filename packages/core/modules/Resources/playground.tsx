"use client";
import dynamic from "next/dynamic";
import React from "react";

// swagger-ui-react + swagger-ui.css are only fetched on /resources/playground.
const PlaygroundUI = dynamic(() => import("./playground-ui"), {
  ssr: false,
  loading: () => <div className="p-4">Loading API Playground...</div>,
});

export default function Page() {
  return <PlaygroundUI />;
}
