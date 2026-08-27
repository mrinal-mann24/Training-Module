export function ThinkingIndicator() {
  return (
    <div className="flex w-full justify-start">
      <div className="flex items-center gap-1 rounded-lg bg-bg-surface px-4 py-3">
        <span className="h-2 w-2 animate-pulse rounded-full bg-ai-thinking" />
        <span className="h-2 w-2 animate-pulse rounded-full bg-ai-thinking [animation-delay:150ms]" />
        <span className="h-2 w-2 animate-pulse rounded-full bg-ai-thinking [animation-delay:300ms]" />
      </div>
    </div>
  );
}
