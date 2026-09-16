/**
 * Suspense fallback for /chat while the server rebuilds the full conversation
 * (buildChatTimeline). Mirrors ChatShell: the slim header, the centred message
 * column, and the composer bar pinned to the bottom, so the page settles into
 * place instead of jumping when the real timeline streams in.
 */
export default function ChatLoading() {
  return (
    <div aria-busy="true" className="flex h-screen flex-col bg-bg-canvas">
      <p role="status" className="sr-only">
        Loading your chat…
      </p>

      <header className="flex items-center justify-between border-b border-border bg-background px-4 py-2.5 font-body">
        <span className="text-base font-semibold tracking-tight text-foreground">✦ AIA Academy</span>
        <div aria-hidden="true" className="h-8 w-20 rounded-lg border border-border" />
      </header>

      <div aria-hidden="true" className="min-h-0 flex-1 overflow-hidden px-4 pt-6 pb-20">
        <div className="mx-auto w-full max-w-287.5 space-y-4 motion-safe:animate-pulse">
          <div className="flex justify-start">
            <div className="w-4/5 space-y-2 rounded-lg bg-bg-surface px-4 py-3">
              <div className="h-5 w-28 rounded-sm bg-bg-canvas" />
              <div className="h-4 w-full rounded-sm bg-border-default" />
              <div className="h-4 w-11/12 rounded-sm bg-border-default" />
              <div className="h-4 w-2/3 rounded-sm bg-border-default" />
            </div>
          </div>

          <div className="flex justify-end">
            <div className="h-12 w-1/3 rounded-lg bg-bg-user-bubble" />
          </div>

          <div className="flex justify-start">
            <div className="w-3/5 space-y-2 rounded-lg bg-bg-surface px-4 py-3">
              <div className="h-4 w-full rounded-sm bg-border-default" />
              <div className="h-4 w-3/4 rounded-sm bg-border-default" />
            </div>
          </div>
        </div>
      </div>

      <div aria-hidden="true" className="border-t border-border-default bg-bg-canvas p-4">
        <div className="mx-auto w-full max-w-287.5 motion-safe:animate-pulse">
          <div className="flex items-center gap-2">
            <div className="h-12 w-12 shrink-0 rounded-full border border-border-default" />
            <div className="h-12 w-full rounded-xl border border-border-default bg-bg-surface" />
            <div className="h-12 w-20 shrink-0 rounded-md bg-bg-surface" />
          </div>
          <div className="mt-2 h-7 w-36 rounded-full border border-border-default" />
        </div>
      </div>
    </div>
  );
}
