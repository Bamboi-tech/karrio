"use client";

import React from "react";
import { cn } from "@karrio/ui/lib/utils";

// One selectable view, same shape as FiltersCard's FilterOption so the
// shipments page can hand the exact same list to either presentation.
// `kind` tells the timeline where a view lives:
//  - "all":     the entry pill on the far left (every status at once)
//  - "stage":   a stop on the main track, left-to-right in lifecycle order
//  - "outcome": a terminal bucket (exception, cancelled, failed) on the
//               branch under the track — things that fell off the line.
export interface TimelineOption {
  label: string;
  value: string[];
  badge?: string;
  kind?: "all" | "stage" | "outcome";
  // Optional one-liner under the label on hover (title attribute).
  hint?: string;
}

interface StatusTimelineProps {
  filters: TimelineOption[];
  activeFilter: string[];
  onFilterChange: (filter: string[]) => void;
  className?: string;
}

const sameSet = (a: string[], b: string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// Keyframes live next to the markup so the component works wherever
// @karrio/ui is consumed, without every host app copying them into its
// tailwind config. Class names are prefixed to keep them out of the way.
const KEYFRAMES = `
@keyframes kt-draw { from { transform: translateY(-50%) scaleX(0); } to { transform: translateY(-50%) scaleX(1); } }
@keyframes kt-rise { from { opacity: 0; transform: translateY(6px) scale(.85); } to { opacity: 1; transform: none; } }
@keyframes kt-halo { 0% { transform: scale(1); opacity: .55; } 100% { transform: scale(2.2); opacity: 0; } }
@keyframes kt-dash { to { stroke-dashoffset: -16; } }
.kt-draw { transform-origin: left; animation: kt-draw .7s cubic-bezier(.22,1,.36,1) both; }
.kt-rise { animation: kt-rise .45s cubic-bezier(.22,1,.36,1) both; }
.kt-halo { animation: kt-halo 1.8s cubic-bezier(.2,.6,.4,1) infinite; }
.kt-flow { stroke-dasharray: 4 4; animation: kt-dash 1.2s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .kt-draw, .kt-rise { animation: none; }
  .kt-halo, .kt-flow { animation: none; opacity: 0; }
}
`;

export const StatusTimeline: React.FC<StatusTimelineProps> = ({
  filters,
  activeFilter,
  onFilterChange,
  className,
}) => {
  const all = filters.find((f) => f.kind === "all");
  const stages = filters.filter((f) => (f.kind ?? "stage") === "stage");
  const outcomes = filters.filter((f) => f.kind === "outcome");

  const isActive = (option: TimelineOption) =>
    sameSet(option.value, activeFilter);
  const isAllActive = !!all && isActive(all);
  const activeIndex = stages.findIndex(isActive);
  const outcomeActive = outcomes.some(isActive);

  // How far the coloured fill reaches along the track: up to the active
  // stop, the whole track on "All", nothing when an outcome bucket is open
  // (those rows left the line). Each stop sits at the centre of an equal
  // column, so stop i is at (i + 0.5) / n of the track width.
  const progress = isAllActive
    ? 1
    : activeIndex < 0
      ? 0
      : (activeIndex + 0.5) / stages.length;

  return (
    <div className={cn("mb-5 mt-4", className)}>
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES }} />
      <div className="overflow-x-auto scrollbar-hide -mx-1 px-1">
        <div className="min-w-[760px]">
          <div className="flex items-start gap-4">
            {/* Entry pill: every status at once. */}
            {all && (
              <button
                type="button"
                onClick={() => onFilterChange(all.value)}
                className={cn(
                  "kt-rise shrink-0 mt-[18px] rounded-full border px-3.5 py-1.5 text-xs font-semibold tracking-wide transition-all duration-200",
                  isAllActive
                    ? "border-green-600 bg-green-600 text-white shadow-sm"
                    : "border-gray-300 bg-white text-gray-600 hover:border-green-400 hover:text-green-700 hover:shadow-sm",
                )}
              >
                {all.label}
              </button>
            )}

            {/* The track and its stops. */}
            <div className="relative flex-1 pt-[32px] pb-1">
              {/* Base line, drawn in from the left on mount. */}
              <div
                className="kt-draw absolute left-0 right-0 top-[32px] h-[8px] -translate-y-1/2 rounded-full bg-gray-200"
                aria-hidden
              />
              {/* Progress fill: slides to the active stop. */}
              <div
                className={cn(
                  "absolute left-0 top-[32px] h-[8px] -translate-y-1/2 rounded-full transition-[width,opacity] duration-700 ease-[cubic-bezier(.22,1,.36,1)]",
                  isAllActive
                    ? "bg-gradient-to-r from-green-300 via-green-500 to-green-300"
                    : "bg-green-500",
                  outcomeActive ? "opacity-0" : "opacity-100",
                )}
                style={{ width: `${progress * 100}%` }}
                aria-hidden
              />

              <ol className="relative flex items-start justify-between -mt-[32px]">
                {stages.map((stage, index) => {
                  const active = isActive(stage);
                  const passed =
                    !outcomeActive && (isAllActive || index < activeIndex);
                  return (
                    <li
                      key={stage.label}
                      className="kt-rise flex flex-1 flex-col items-center"
                      style={{ animationDelay: `${120 + index * 70}ms` }}
                    >
                      <button
                        type="button"
                        onClick={() => onFilterChange(stage.value)}
                        title={stage.hint}
                        aria-current={active ? "step" : undefined}
                        className="group flex flex-col items-center focus:outline-none"
                      >
                        {/* Count badge floats above the stop. */}
                        <span
                          className={cn(
                            "mb-1 h-5 min-w-[20px] rounded-full px-1.5 text-[11px] font-semibold leading-5 transition-all duration-300",
                            stage.badge == null && "invisible",
                            active
                              ? "bg-green-600 text-white"
                              : "bg-gray-100 text-gray-600 group-hover:bg-green-50 group-hover:text-green-700",
                          )}
                        >
                          {stage.badge ?? "0"}
                        </span>

                        {/* The stop itself. */}
                        <span className="relative flex h-5 w-5 items-center justify-center">
                          {active && (
                            <span
                              className="kt-halo absolute inset-0 rounded-full bg-green-500"
                              aria-hidden
                            />
                          )}
                          <span
                            className={cn(
                              "relative block rounded-full border-2 bg-white transition-all duration-300 ease-out",
                              active
                                ? "h-5 w-5 border-green-600 bg-green-600 shadow-[0_0_0_4px_rgba(22,163,74,.18)]"
                                : passed
                                  ? "h-3.5 w-3.5 border-green-500 bg-green-500"
                                  : "h-3.5 w-3.5 border-gray-300 group-hover:border-green-400 group-hover:scale-125",
                            )}
                          />
                        </span>

                        <span
                          className={cn(
                            "mt-2 max-w-[92px] text-center text-xs leading-tight transition-colors duration-200",
                            active
                              ? "font-semibold text-green-700"
                              : passed
                                ? "font-medium text-gray-700"
                                : "text-gray-500 group-hover:text-gray-800",
                          )}
                        >
                          {stage.label}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>

          {/* Branch: where shipments end up when they leave the line. */}
          {outcomes.length > 0 && (
            <div
              className="kt-rise mt-1 flex items-center justify-end gap-2 pr-1"
              style={{ animationDelay: `${140 + stages.length * 70}ms` }}
            >
              <svg
                width="56"
                height="26"
                viewBox="0 0 56 26"
                className="text-gray-300 shrink-0"
                aria-hidden
              >
                <path
                  d="M4 0 C4 14, 14 13, 26 13 L52 13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className={outcomeActive ? "kt-flow text-green-400" : ""}
                />
                <path
                  d="M46 8 L52 13 L46 18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={outcomeActive ? "text-green-400" : ""}
                />
              </svg>
              {outcomes.map((outcome) => {
                const active = isActive(outcome);
                return (
                  <button
                    key={outcome.label}
                    type="button"
                    onClick={() => onFilterChange(outcome.value)}
                    title={outcome.hint}
                    className={cn(
                      "rounded-md border px-2.5 py-1 text-xs font-medium transition-all duration-200",
                      active
                        ? "border-green-600 bg-green-600 text-white shadow-sm"
                        : "border-dashed border-gray-300 bg-white text-gray-500 hover:border-green-400 hover:text-green-700 hover:border-solid",
                    )}
                  >
                    {outcome.label}
                    {outcome.badge != null && (
                      <span
                        className={cn(
                          "ml-1.5 rounded-full px-1.5 text-[11px] font-semibold",
                          active
                            ? "bg-white/20 text-white"
                            : "bg-gray-100 text-gray-600",
                        )}
                      >
                        {outcome.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
