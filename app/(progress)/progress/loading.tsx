// Enough placeholder module cards to fill the first screen. The real page
// renders one card per module with one concept in each (CONCEPT_TO_MODULE).
const SKELETON_MODULES = [
  { id: 'module-a', labelClassName: 'h-4 w-40 max-w-full rounded-sm bg-border-default' },
  { id: 'module-b', labelClassName: 'h-4 w-48 max-w-full rounded-sm bg-border-default' },
  { id: 'module-c', labelClassName: 'h-4 w-36 max-w-full rounded-sm bg-border-default' },
  { id: 'module-d', labelClassName: 'h-4 w-44 max-w-full rounded-sm bg-border-default' },
  { id: 'module-e', labelClassName: 'h-4 w-52 max-w-full rounded-sm bg-border-default' },
  { id: 'module-f', labelClassName: 'h-4 w-40 max-w-full rounded-sm bg-border-default' },
] as const;

/**
 * Suspense fallback for /progress while mastery and module progress load.
 * Mirrors the page: the "Module · Level" heading and blurb above a two-column
 * grid of module cards, each with its concept row and status badge. A skeleton
 * block is one step darker than the ground it sits on.
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
          <div className="h-7 w-56 rounded-md bg-bg-surface" />
          <div className="mt-1 h-5 w-full max-w-xl rounded-md bg-bg-surface" />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {SKELETON_MODULES.map((skeleton) => (
            <div
              key={skeleton.id}
              className="rounded-lg border border-border-default bg-bg-surface p-4"
            >
              <div className="mb-3 h-5 w-20 rounded-sm bg-border-default" />
              <div className="flex h-5.5 items-center justify-between gap-3">
                <div className={skeleton.labelClassName} />
                <div className="h-5 w-16 shrink-0 rounded-sm bg-border-default" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
