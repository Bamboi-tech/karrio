import React from "react";

export type UsageSparklinePoint = { label: string; value: number };

/**
 * Bar sparkline for the dashboard stat cards. Plain SVG on purpose: it
 * renders on the server with the prefetched usage and needs no chart
 * library, so the home page ships no recharts chunk. Hovering a day shows
 * its label and value through the native <title> tooltip.
 */
export function UsageSparkline({
  data,
  className,
}: {
  data: UsageSparklinePoint[];
  className?: string;
}) {
  const max = Math.max(0, ...data.map((point) => point.value));
  const slots = Math.max(1, data.length);
  const first = data[0]?.label;
  const last = data[data.length - 1]?.label;

  return (
    <div className={`flex h-full w-full flex-col ${className ?? ""}`}>
      <svg
        viewBox={`0 0 ${slots} 100`}
        preserveAspectRatio="none"
        className="min-h-0 w-full flex-1"
        role="img"
        aria-label={`${first ?? ""} to ${last ?? ""}`}
      >
        {data.map((point, index) => {
          const height = max > 0 ? (point.value / max) * 100 : 0;
          return (
            <g key={point.label}>
              <title>{`${point.label}: ${point.value}`}</title>
              {/* full-height hit area so empty days still show a tooltip */}
              <rect x={index} y={0} width={1} height={100} fill="transparent" />
              <rect
                x={index + 0.15}
                y={100 - height}
                width={0.7}
                height={height}
                fill="#3b82f6"
              />
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between pt-1 text-[10px] leading-none text-muted-foreground">
        <span>{first}</span>
        <span>{last}</span>
      </div>
    </div>
  );
}
