"use client";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";
import React from "react";

// Leaf module that owns the recharts import; `Shippers/overview.tsx` and
// `Shippers/markups.tsx` load it with `next/dynamic` so recharts is only
// fetched when a chart renders.
export function SpendLineChart({
  data,
  dataKey,
  label,
}: {
  data: Record<string, any>[];
  dataKey: string;
  label: string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart
        data={data}
        margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
        <XAxis
          dataKey="name"
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 12, fill: "#64748b" }}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "#1e293b",
            border: "none",
            borderRadius: "6px",
            color: "white",
            fontSize: "12px",
          }}
          formatter={(value: any) => [`$${value.toLocaleString()}`, label]}
        />
        <Line
          type="linear"
          dataKey={dataKey}
          stroke="#3b82f6"
          strokeWidth={2}
          dot={false}
          name={dataKey}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
