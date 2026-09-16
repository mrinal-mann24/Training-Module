'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { buttonVariants } from '@/app/components/ui/button';

type DashboardErrorProps = {
  error: Error & { digest?: string };
  retry: () => void;
};

/**
 * Error boundary for /dashboard. It never renders `error.message` (it can
 * carry internal detail). "Try again" calls `retry`, which refreshes the server
 * data before re-rendering; the safe way out is the home page.
 */
export default function DashboardError({ error, retry }: DashboardErrorProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  // Next does not guarantee the thrown value is an Error object.
  const digest = error?.digest;

  return (
    <div className="min-h-svh w-full bg-background font-body">
      <header className="flex items-center px-6 py-5 md:px-12 lg:px-20">
        <span className="text-xl font-semibold tracking-tight text-foreground">✦ AIA Academy</span>
      </header>

      <main className="mx-auto w-full max-w-5xl px-6 pb-24 pt-12 md:pt-16">
        <div role="alert" className="max-w-xl rounded-2xl border border-border bg-secondary/50 p-8">
          <h1 className="font-display text-4xl tracking-tight text-foreground">
            Something went <em className="italic">wrong</em>
          </h1>
          <p className="mt-3 text-base leading-relaxed text-muted-foreground">
            We couldn&apos;t open your dashboard just now. Try again, or go back to the home page.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <button type="button" onClick={() => retry()} className={buttonVariants()}>
              Try again
            </button>
            <Link href="/" className={buttonVariants({ variant: 'outline' })}>
              Go to the home page
            </Link>
          </div>

          {digest && (
            <p className="mt-6 text-xs text-muted-foreground">
              Reference code: <span className="font-mono">{digest}</span>
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
