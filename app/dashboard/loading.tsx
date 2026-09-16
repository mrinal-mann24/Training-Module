/**
 * Suspense fallback for /dashboard while the session and onboarding checks
 * run. Mirrors the page: wordmark header with the Log out button, the display
 * heading and lede, and the two-card grid. A skeleton block is one step darker
 * than the ground it sits on (`bg-secondary` on white, `bg-border` on the grey
 * card).
 */
export default function DashboardLoading() {
  return (
    <div aria-busy="true" className="min-h-svh w-full bg-background font-body">
      <p role="status" className="sr-only">
        Loading your dashboard…
      </p>

      <header className="flex items-center justify-between px-6 py-5 md:px-12 lg:px-20">
        <span className="text-xl font-semibold tracking-tight text-foreground">✦ AIA Academy</span>
        <div aria-hidden="true" className="h-10 w-24 rounded-full border border-border" />
      </header>

      <main className="mx-auto w-full max-w-5xl px-6 pb-24 pt-12 md:pt-16">
        <div aria-hidden="true" className="motion-safe:animate-pulse">
          <div className="h-12 w-72 max-w-full rounded-xl bg-secondary md:h-16 md:w-96" />
          <div className="mt-4 h-6 w-full max-w-md rounded-md bg-secondary md:h-7" />

          <div className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2">
            <div className="flex min-h-60 flex-col justify-between rounded-2xl border border-border bg-secondary/50 p-8">
              <div>
                <div className="h-4 w-16 rounded-sm bg-border" />
                <div className="mt-3 h-9 w-3/4 rounded-md bg-border" />
                <div className="mt-2 h-5 w-1/3 rounded-sm bg-border" />
              </div>
              <div className="h-8 w-32 rounded-full border border-border bg-background" />
            </div>

            <div className="flex min-h-60 flex-col justify-between rounded-2xl border border-border bg-background p-8">
              <div>
                <div className="h-4 w-12 rounded-sm bg-secondary" />
                <div className="mt-3 h-9 w-5/6 rounded-md bg-secondary" />
                <div className="mt-2 h-5 w-2/3 rounded-sm bg-secondary" />
              </div>
              <div className="h-11 w-11 self-end rounded-full bg-secondary" />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
