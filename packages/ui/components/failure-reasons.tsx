"use client";

import * as React from "react";
import { cn } from "@karrio/ui/lib/utils";
import { formatDateTime } from "@karrio/lib";
import { toDisplayText } from "@karrio/ui/lib/error-text";

interface FailureReason {
  id: string;
  message: string;
  code: string | null;
  carrier: string | null;
  timestamp: string | null;
}

interface FailureReasonsProps {
  response: any;
  records: any[];
  requestedAt: string | null;
  className?: string;
}

// Every field below is coerced with toDisplayText: log payloads are
// untrusted JSON and an error can arrive as an object (a serialized Django
// lazy translation proxy), which React refuses as a child — it throws and the
// root ErrorBoundary then replaces the whole page.
function extractReasons(
  response: any,
  records: any[],
  requestedAt: string | null,
): FailureReason[] {
  const reasons: FailureReason[] = [];

  // Extract API-level errors from response
  const parsed = typeof response === "string"
    ? (() => { try { return JSON.parse(response); } catch { return response; } })()
    : response;

  if (parsed && typeof parsed === "object") {
    // Handle errors array
    const errors = parsed.errors || parsed.messages || [];
    (Array.isArray(errors) ? errors : []).forEach((err: any, i: number) => {
      const message = toDisplayText(
        typeof err === "string"
          ? err
          : err?.message || err?.details || err?.detail || err,
      );
      reasons.push({
        id: `api-error-${i}`,
        message,
        code: toDisplayText(err?.code || err?.carrier_id) || null,
        carrier: toDisplayText(err?.carrier_name || err?.carrier) || null,
        timestamp: requestedAt,
      });
    });

    // Handle single error message
    if (reasons.length === 0 && (parsed.error || parsed.message || parsed.detail)) {
      reasons.push({
        id: "api-error-single",
        message: toDisplayText(
          parsed.error || parsed.message || parsed.detail,
        ),
        code:
          toDisplayText(parsed.code) || String(parsed.status_code || ""),
        carrier: null,
        timestamp: requestedAt,
      });
    }
  }

  // Extract carrier-level errors from tracing records
  (records || []).forEach((record, i) => {
    if (!record) return;

    const meta = record.meta || {};
    const rec = typeof record.record === "string"
      ? (() => { try { return JSON.parse(record.record); } catch { return record.record; } })()
      : record.record;

    if (!rec) return;

    // Look for error data in the record
    const errorData = rec.error || rec.response;
    if (!errorData) return;

    const parsedError = typeof errorData === "string"
      ? (() => { try { return JSON.parse(errorData); } catch { return errorData; } })()
      : errorData;

    if (typeof parsedError === "string") {
      reasons.push({
        id: `trace-error-${i}`,
        message: parsedError,
        code: null,
        carrier:
          toDisplayText(
            meta.connection?.carrier_name || meta.carrier_name,
          ) || null,
        timestamp: record.timestamp
          ? new Date(record.timestamp * 1000).toISOString()
          : null,
      });
    } else if (parsedError && typeof parsedError === "object") {
      const traceErrors = parsedError.errors || parsedError.messages || [];
      if (Array.isArray(traceErrors) && traceErrors.length > 0) {
        traceErrors.forEach((err: any, j: number) => {
          const message = toDisplayText(
            typeof err === "string"
              ? err
              : err?.message || err?.details || err?.detail || err,
          );
          reasons.push({
            id: `trace-error-${i}-${j}`,
            message,
            code: toDisplayText(err?.code) || null,
            carrier:
              toDisplayText(
                meta.connection?.carrier_name || meta.carrier_name,
              ) || null,
            timestamp: record.timestamp
              ? new Date(record.timestamp * 1000).toISOString()
              : null,
          });
        });
      } else if (parsedError.error || parsedError.message || parsedError.detail) {
        reasons.push({
          id: `trace-error-${i}`,
          message: toDisplayText(
            parsedError.error || parsedError.message || parsedError.detail,
          ),
          code: toDisplayText(parsedError.code) || null,
          carrier:
            toDisplayText(
              meta.connection?.carrier_name || meta.carrier_name,
            ) || null,
          timestamp: record.timestamp
            ? new Date(record.timestamp * 1000).toISOString()
            : null,
        });
      }
    }
  });

  return reasons;
}

export const FailureReasons: React.FC<FailureReasonsProps> = ({
  response,
  records,
  requestedAt,
  className,
}) => {
  const reasons = React.useMemo(
    () => extractReasons(response, records, requestedAt),
    [response, records, requestedAt],
  );

  return (
    <div className={cn("space-y-4", className)}>
      {reasons.length === 0 ? (
        <div className="text-sm text-gray-500">
          No failure details available
        </div>
      ) : (
        <>
          {reasons.map((reason, index) => (
            <div key={reason.id}>
              <div className="flex items-start gap-3">
                {/* Error Icon */}
                <div className="flex-shrink-0">
                  <i className="fas fa-circle text-red-500 text-xs" />
                </div>

                {/* Error Content */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900">
                    {reason.message}
                  </div>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    {reason.carrier && (
                      <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                        {reason.carrier}
                      </span>
                    )}
                    {reason.code && (
                      <span className="text-xs text-gray-500 font-mono">
                        {reason.code}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {reason.timestamp
                      ? formatDateTime(reason.timestamp)
                      : "Timestamp not available"}
                  </div>
                </div>
              </div>

              {/* Connecting Line */}
              {index < reasons.length - 1 && (
                <div className="flex -my-2">
                  <div className="w-6 flex justify-start pl-1">
                    <div className="w-px h-8 bg-gray-300"></div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
};