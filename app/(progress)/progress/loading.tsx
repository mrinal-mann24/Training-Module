import { ProductHeader } from '@/app/components/ProductHeader';

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
 * page: the product header pill, back link, heading, blurb and overall bar
 * above a two-column grid of the five module cards, each with its concept
 * rows and status badges. A skeleton block is one step darker than the ground
 * it sits on.
 */
export default function ProgressLoading() {
  return (
    <div aria-busy="true" className="day relative isolate min-h-svh w-full">
      <p role="status" className="sr-only">
        Loading your progress…
      </p>

      <ProductHeader />

      <main
        className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 pb-24 pt-10 motion-safe:animate-pulse md:px-8"
      >
        <div aria-hidden="true">
          <div className="h-6 w-36 rounded-md bg-day-card" />
          <div className="mt-3 h-10 w-56 rounded-md bg-day-card" />
          <div className="mt-2 h-6 w-full max-w-xl rounded-md bg-day-card" />
          <div className="mt-4 flex items-center gap-3">
            <div className="h-2 w-full max-w-md rounded-full bg-day-line" />
            <div className="h-5 w-32 shrink-0 rounded-sm bg-day-card" />
          </div>
        </div>

        <div aria-hidden="true" className="grid gap-5 lg:grid-cols-2">
          {SKELETON_MODULES.map((skeleton) => (
            <div
              key={skeleton.id}
              className="rounded-card border border-day-line bg-day-card p-2.5"
            >
              <div className="h-full rounded-panel bg-white p-6">
                <div className="mb-1 flex items-baseline justify-between gap-3">
                  <div className="h-6 w-40 max-w-full rounded-sm bg-day-card" />
                  <div className="h-4 w-14 shrink-0 rounded-sm bg-day-card" />
                </div>
                <div className="mb-4 h-5 w-full max-w-xs rounded-sm bg-day-card" />
                <div className="flex flex-col gap-2.5">
                  {Array.from({ length: skeleton.conceptCount }, (_, index) => (
                    <div key={index} className="flex h-6.5 items-center justify-between gap-3">
                      <div className="h-4 w-44 max-w-full rounded-sm bg-day-card" />
                      <div className="h-6.5 w-20 shrink-0 rounded-full bg-day-card" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
