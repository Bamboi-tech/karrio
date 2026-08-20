// API log payloads are untrusted JSON. Some rows carry an error that is an
// OBJECT rather than a string — a Django lazy translation proxy that got
// serialized, shaped {"_args": ["..."], "_kw": {}}. React refuses an object
// as a child and throws, which took the whole Shipments page down through the
// root ErrorBoundary; a `title=` attribute silently degrades to
// "[object Object]". Everything rendered out of a log payload goes through
// here first, so the result is ALWAYS a string.

// The lazy proxy keeps its readable text as the first positional argument.
const LAZY_PROXY_ARGS_KEY = "_args";

export function toDisplayText(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value || fallback;
  if (typeof value === "number" || typeof value === "boolean")
    return `${value}`;
  if (Array.isArray(value))
    return (
      value
        .map((item) => toDisplayText(item))
        .filter(Boolean)
        .join(", ") || fallback
    );
  if (typeof value === "object") {
    const args = (value as Record<string, unknown>)[LAZY_PROXY_ARGS_KEY];
    if (Array.isArray(args) && args.length > 0)
      return toDisplayText(args[0], fallback);
    // Anything else: compact JSON is readable, "[object Object]" is not.
    try {
      return JSON.stringify(value) || fallback;
    } catch (error) {
      return fallback;
    }
  }
  return fallback;
}
