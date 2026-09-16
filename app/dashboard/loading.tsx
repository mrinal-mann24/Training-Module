import { ProductHeader } from "@/app/components/ProductHeader";

/**
 * Suspense fallback for /dashboard while the session and onboarding checks
 * run. Mirrors the page: the product header pill, the heading and lede, the
 * progress card, and the two-card grid. A skeleton block is one step darker
 * than the ground it sits on (`bg-day-card` on white, `bg-day-line` on the
 * grey or blue-tinted grounds).
 */
export default function DashboardLoading() {
  return (
    <div aria-busy="true" className="day relative isolate min-h-svh w-full">
      <p role="status" className="sr-only">
        Loading your dashboard…
      </p>

      <ProductHeader />

      <main className="mx-auto w-full max-w-5xl px-5 pb-24 pt-12 md:px-8 md:pt-16">
        <div aria-hidden="true" className="motion-safe:animate-pulse">
          <div className="h-12 w-72 max-w-full rounded-xl bg-day-card md:h-16 md:w-96" />
          <div className="mt-4 h-6 w-full max-w-md rounded-md bg-day-card md:h-7" />

          <div className="mt-10 rounded-card border border-day-line bg-day-card p-2.5">
            <div className="rounded-panel bg-white p-6 md:p-8">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <div className="h-4 w-28 rounded-sm bg-day-card" />
                <div className="h-5 w-48 max-w-full rounded-sm bg-day-card" />
              </div>
              <div className="mt-4 h-2 w-full rounded-full bg-day-line" />
              <div className="mt-3 h-5 w-64 max-w-full rounded-sm bg-day-card" />
            </div>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
            <div className="rounded-card border border-day-line bg-day-card p-2.5">
              <div className="flex min-h-60 flex-col justify-between rounded-panel border border-day-line bg-white p-8">
                <div>
                  <div className="h-4 w-16 rounded-sm bg-day-card" />
                  <div className="mt-3 h-9 w-3/4 rounded-md bg-day-card" />
                  <div className="mt-2 h-5 w-1/3 rounded-sm bg-day-card" />
                </div>
                <div className="h-8 w-32 rounded-full border border-day-line bg-white" />
              </div>
            </div>

            <div className="rounded-card border border-day-line bg-day-card p-2.5">
              <div className="flex min-h-60 flex-col justify-between rounded-panel bg-day-soft p-8">
                <div>
                  <div className="h-4 w-12 rounded-sm bg-day-line" />
                  <div className="mt-3 h-9 w-5/6 rounded-md bg-day-line" />
                  <div className="mt-2 h-5 w-2/3 rounded-sm bg-day-line" />
                </div>
                <div className="size-12 self-end rounded-full bg-day-line" />
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
