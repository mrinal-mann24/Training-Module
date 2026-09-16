// One placeholder per major module (MAJOR_MODULES, 2026-09-16), each showing
// as many concept rows as that module actually has, so the skeleton is the
// shape of the page rather than a generic grid.
const SKELETON_MODULES = [
  { id: 'sales_receivables', conceptCount: 2 },
  { id: 'purchases_payables', conceptCount: 5 },
  { id: 'banking', conceptCount: 3 },
  { id: 'tax', conceptCount: 6 },
  { id: 'month_end', conceptCount: 3 },
] as const;

/**
 * Suspense fallback for /progress while the mastery map loads. Mirrors the
 * page: back link, heading, blurb and overall bar above a two-column grid of
 * the five module cards, each with its concept rows and status badges. A
 * skeleton block is one step darker than the ground it sits on.
 */
export default function ProgressLoading() {
  return (
    <main aria-busy="true" className="min-h-screen bg-bg-canvas px-4 py-10">
      <p role="status" className="sr-only">
        Loading your progress…
      </p>

      <div
        aria-hidden="true"
        className="mx-auto flex w-full max-w-287.5 flex-col gap-6 motion-safe:animate-pulse"
      >
        <div>
          <div className="h-5 w-36 rounded-md bg-bg-surface" />
          <div className="mt-3 h-7 w-56 rounded-md bg-bg-surface" />
          <div className="mt-1 h-5 w-full max-w-xl rounded-md bg-bg-surface" />
          <div className="mt-4 flex items-center gap-3">
            <div className="h-2 w-full max-w-md rounded-full bg-bg-surface" />
            <div className="h-5 w-32 shrink-0 rounded-sm bg-bg-surface" />
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {SKELETON_MODULES.map((skeleton) => (
            <div
              key={skeleton.id}
              className="rounded-lg border border-border-default bg-bg-surface p-4"
            >
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <div className="h-5 w-40 max-w-full rounded-sm bg-border-default" />
                <div className="h-4 w-14 shrink-0 rounded-sm bg-border-default" />
              </div>
              <div className="mb-3 h-4 w-full max-w-xs rounded-sm bg-border-default" />
              <div className="flex flex-col gap-2">
                {Array.from({ length: skeleton.conceptCount }, (_, index) => (
                  <div key={index} className="flex h-5.5 items-center justify-between gap-3">
                    <div className="h-4 w-44 max-w-full rounded-sm bg-border-default" />
                    <div className="h-5 w-16 shrink-0 rounded-sm bg-border-default" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
