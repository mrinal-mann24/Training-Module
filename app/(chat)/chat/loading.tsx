import { ProductHeader } from '@/app/components/ProductHeader';

/**
 * Suspense fallback for /chat while the server rebuilds the full conversation
 * (buildChatTimeline). Mirrors ChatShell: the header pill, the video library
 * column on md+, the centred message column, and the composer bar pinned to
 * the bottom, so the page settles into place instead of jumping when the real
 * timeline streams in.
 */
export default function ChatLoading() {
  return (
    <div aria-busy="true" className="day flex h-dvh flex-col">
      <p role="status" className="sr-only">
        Loading your chat…
      </p>

      <ProductHeader className="pb-3 md:pb-4" />

      <div aria-hidden="true" className="flex min-h-0 flex-1">
        <div className="hidden w-72 shrink-0 flex-col gap-4 overflow-hidden border-r border-day-line bg-day-bg p-4 motion-safe:animate-pulse md:flex">
          <div className="h-6 w-32 rounded-full bg-day-card" />
          <div className="aspect-video rounded-panel bg-day-card" />
          <div className="aspect-video rounded-panel bg-day-card" />
          <div className="aspect-video rounded-panel bg-day-card" />
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden px-4 pt-8 pb-20 md:px-8">
            <div className="mx-auto w-full max-w-287.5 space-y-6 motion-safe:animate-pulse">
              <div className="flex justify-start">
                <div className="w-4/5 space-y-2 rounded-panel bg-day-card px-6 py-5">
                  <div className="h-5 w-28 rounded-full bg-white" />
                  <div className="h-4 w-full rounded-full bg-day-line" />
                  <div className="h-4 w-11/12 rounded-full bg-day-line" />
                  <div className="h-4 w-2/3 rounded-full bg-day-line" />
                </div>
              </div>

              <div className="flex justify-end">
                <div className="h-14 w-1/3 rounded-panel bg-day-card" />
              </div>

              <div className="flex justify-start">
                <div className="w-3/5 space-y-2 rounded-panel bg-day-card px-6 py-5">
                  <div className="h-4 w-full rounded-full bg-day-line" />
                  <div className="h-4 w-3/4 rounded-full bg-day-line" />
                </div>
              </div>
            </div>
          </div>

          <div className="border-t border-day-line bg-day-bg px-4 py-4 md:px-8">
            <div className="mx-auto w-full max-w-287.5 motion-safe:animate-pulse">
              <div className="flex items-center gap-3">
                <div className="size-12 shrink-0 rounded-full border border-day-line bg-white" />
                <div className="h-12 w-full rounded-full border border-day-line bg-white" />
                <div className="h-12 w-24 shrink-0 rounded-full bg-day-card" />
              </div>
              <div className="mt-3 h-8 w-40 rounded-full border border-day-line bg-white" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
