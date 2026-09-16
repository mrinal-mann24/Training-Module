export function ThinkingIndicator() {
  return (
    <div className="flex w-full justify-start">
      <div className="flex items-center gap-1 rounded-panel bg-day-card px-6 py-5">
        <span className="h-2 w-2 animate-pulse rounded-full bg-day-blue/60" />
        <span className="h-2 w-2 animate-pulse rounded-full bg-day-blue/60 [animation-delay:150ms]" />
        <span className="h-2 w-2 animate-pulse rounded-full bg-day-blue/60 [animation-delay:300ms]" />
      </div>
    </div>
  );
}
