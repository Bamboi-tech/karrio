"use client";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import React from "react";

// Leaf module that owns the recharts import; `Dashboard/index.tsx` loads it
// with `next/dynamic` so recharts is only fetched when a chart renders.
export function DashboardBarChart({
  data,
  dataKey,
}: {
  data: Record<string, any>[];
  dataKey: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={120}>
      <BarChart data={data}>
        <Tooltip
          contentStyle={{
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "8px",
            fontSize: "12px",
            boxShadow: "none",
          }}
        />
        <Bar dataKey={dataKey} fill="#3b82f6" radius={[4, 4, 0, 0]} />
        <XAxis
          dataKey="name"
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          interval="preserveStartEnd"
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
