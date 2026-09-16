'use client';

import { useEffect } from 'react';
import Link from 'next/link';

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
    <main className="day flex min-h-svh w-full items-center justify-center px-5 py-10">
      <div role="alert" className="w-full max-w-md rounded-card border border-day-line bg-day-card p-2.5">
        <div className="rounded-panel bg-white p-8 text-center">
          <h1 className="day-title font-nunito">
            Something went <em>wrong</em>
          </h1>
          <p className="mt-3 font-nunito text-base text-day-muted">
            We couldn&apos;t show your progress just now. Try again, or head back to your dashboard.
          </p>

          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={() => retry()}
              className="inline-flex h-11 cursor-pointer items-center rounded-full bg-day-blue px-6 font-urbanist text-base text-white transition-colors duration-200 hover:bg-day-blue-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-day-blue"
            >
              Try again
            </button>
            <Link
              href="/dashboard"
              className="inline-flex h-11 items-center rounded-full border border-day-line bg-white px-6 font-urbanist text-base text-day-ink transition-colors duration-200 hover:border-day-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-day-blue"
            >
              Back to dashboard
            </Link>
          </div>

          {digest && (
            <p className="mt-6 font-nunito text-xs text-day-muted">
              Reference code: <span className="font-mono">{digest}</span>
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
