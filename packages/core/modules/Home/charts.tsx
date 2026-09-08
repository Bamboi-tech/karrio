"use client";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import React from "react";

// Leaf module that owns the recharts import; `Home/index.tsx` loads it with
// `next/dynamic` so recharts (~330 KB gz) is only fetched when a chart renders.
export function UsageBarChart({
  data,
  dataKey,
  ticks,
}: {
  data: Record<string, any>[];
  dataKey: string;
  ticks: string[];
}) {
  return (
    <ResponsiveContainer width="100%" height={150}>
      <BarChart data={data}>
        <Tooltip />
        <Bar dataKey={dataKey} fill="#79e5dd" />
        <XAxis
          height={10}
          dataKey="name"
          interval={"preserveStartEnd"}
          stroke={"#ddd"}
          tick={{ fill: "#000000" }}
          style={{ fontSize: "0.6rem" }}
          ticks={ticks}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
