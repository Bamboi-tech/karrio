// Route-level loading UI for every dashboard page. Rendered inside the shared
// dashboard layout (sidebar + navbar stay in place) while the page segment's
// server chain resolves, so a sidebar click gives immediate feedback.
export default function Loading() {
  return (
    <div
      className="animate-pulse space-y-6"
      aria-busy="true"
      aria-label="Loading"
    >
      <div className="flex items-center justify-between">
        <div className="h-7 w-40 rounded bg-slate-200" />
        <div className="flex gap-2">
          <div className="h-9 w-24 rounded bg-slate-200" />
          <div className="h-9 w-28 rounded bg-slate-200" />
        </div>
      </div>
      <div className="flex gap-2">
        <div className="h-8 w-20 rounded bg-slate-200" />
        <div className="h-8 w-20 rounded bg-slate-200" />
        <div className="h-8 w-20 rounded bg-slate-200" />
        <div className="h-8 w-20 rounded bg-slate-200" />
      </div>
      <div className="rounded-lg border border-slate-200 bg-white">
        <div className="h-10 border-b border-slate-200 bg-slate-50" />
        {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
          <div
            key={row}
            className="flex items-center gap-4 border-b border-slate-100 px-4 py-3 last:border-b-0"
          >
            <div className="h-4 w-16 rounded bg-slate-200" />
            <div className="h-4 w-48 rounded bg-slate-200" />
            <div className="h-4 w-32 rounded bg-slate-200" />
            <div className="h-4 w-24 rounded bg-slate-200" />
            <div className="ml-auto h-4 w-20 rounded bg-slate-200" />
          </div>
        ))}
      </div>
    </div>
  );
}
