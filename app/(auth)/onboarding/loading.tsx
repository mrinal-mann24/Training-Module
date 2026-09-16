/**
 * Suspense fallback for /onboarding. It renders inside the auth shell's `.day`
 * surface, so it mirrors the onboarding card: the grey `rounded-card` shell
 * around a white `rounded-panel`, the centred title and blurb, the name field,
 * the two licence choices, the date field and the pill submit.
 */
export default function OnboardingLoading() {
  return (
    <div
      aria-busy="true"
      className="w-full max-w-lg rounded-card border border-day-line bg-day-card p-2.5"
    >
      <p role="status" className="sr-only">
        Loading your workspace setup…
      </p>

      <div aria-hidden="true" className="rounded-panel bg-white p-8 max-md:p-6 motion-safe:animate-pulse">
        <div className="mx-auto h-11 w-72 max-w-full rounded-full bg-day-card" />
        <div className="mx-auto mt-2 mb-8 h-6 w-80 max-w-full rounded-full bg-day-card" />

        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <div className="h-6 w-24 rounded-full bg-day-card" />
            <div className="h-5 w-64 max-w-full rounded-full bg-day-card" />
            <div className="h-12 w-full rounded-2xl border border-day-line" />
          </div>

          <div className="flex flex-col gap-2">
            <div className="h-6 w-36 rounded-full bg-day-card" />
            <div className="grid grid-cols-2 gap-3">
              <div className="h-12 rounded-2xl border border-day-line" />
              <div className="h-12 rounded-2xl border border-day-line" />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="h-6 w-36 rounded-full bg-day-card" />
            <div className="h-12 w-full rounded-2xl border border-day-line" />
          </div>

          <div className="h-12 w-full rounded-full bg-day-card" />
        </div>
      </div>
    </div>
  );
}
