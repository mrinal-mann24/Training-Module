'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { buttonVariants } from '@/app/components/ui/button';

type ChatErrorProps = {
  error: Error & { digest?: string };
  retry: () => void;
};

/**
 * Error boundary for /chat. It never renders `error.message`: errors thrown in
 * Client Components keep their original text, which can carry internal detail.
 * "Try again" calls `retry` (stable since Next 16.3), which refreshes the
 * server data and then re-renders; `reset` alone would re-render the same
 * failed Server Component payload.
 */
export default function ChatError({ error, retry }: ChatErrorProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  // Next does not guarantee the thrown value is an Error object.
  const digest = error?.digest;

  return (
    <div className="flex h-screen flex-col bg-bg-canvas">
      <header className="flex items-center border-b border-border bg-background px-4 py-2.5 font-body">
        <span className="text-base font-semibold tracking-tight text-foreground">✦ AIA Academy</span>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div
          role="alert"
          className="w-full max-w-md rounded-2xl border border-border-default bg-bg-surface p-8 text-center"
        >
          <h1 className="font-display text-3xl tracking-tight text-text-primary">
            Something went <em className="italic">wrong</em>
          </h1>
          <p className="mt-3 text-base text-text-secondary">
            We couldn&apos;t open your chat just now. Try again, and if it keeps happening, head
            back to your dashboard.
          </p>

          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <button type="button" onClick={() => retry()} className={buttonVariants()}>
              Try again
            </button>
            <Link href="/dashboard" className={buttonVariants({ variant: 'outline' })}>
              Back to dashboard
            </Link>
          </div>

          {digest && (
            <p className="mt-6 text-xs text-text-muted">
              Reference code: <span className="font-mono">{digest}</span>
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
