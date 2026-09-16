'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { buttonVariants } from '@/app/components/ui/button';

type ProgressErrorProps = {
  error: Error & { digest?: string };
  retry: () => void;
};

/**
 * Error boundary for /progress. It never renders `error.message` (it can carry
 * internal detail). "Try again" calls `retry`, which refreshes the server data
 * before re-rendering, so a failed mastery read gets a real second attempt.
 */
export default function ProgressError({ error, retry }: ProgressErrorProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  // Next does not guarantee the thrown value is an Error object.
  const digest = error?.digest;

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-canvas px-4 py-10">
      <div
        role="alert"
        className="w-full max-w-md rounded-2xl border border-border-default bg-bg-surface p-8 text-center"
      >
        <h1 className="font-display text-3xl tracking-tight text-text-primary">
          Something went <em className="italic">wrong</em>
        </h1>
        <p className="mt-3 text-base text-text-secondary">
          We couldn&apos;t show your progress just now. Try again, or head back to your dashboard.
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
  );
}
