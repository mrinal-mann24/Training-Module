'use client';

import { useEffect } from 'react';
import Link from 'next/link';

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
    <div className="day relative isolate min-h-svh w-full">
      <header className="relative z-10 px-4 pt-4 md:px-8">
        <div className="mx-auto flex h-14 max-w-5xl items-center rounded-full bg-day-panel px-6 md:px-10">
          <span className="font-urbanist text-xl text-white">✦ AIA Academy</span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-5 pb-24 pt-12 md:px-8 md:pt-16">
        <div role="alert" className="max-w-xl rounded-card border border-day-line bg-day-card p-2.5">
          <div className="rounded-panel bg-white p-8">
            <h1 className="day-title font-nunito">
              Something went <em>wrong</em>
            </h1>
            <p className="mt-3 font-nunito text-base leading-relaxed text-day-muted">
              We couldn&apos;t open your dashboard just now. Try again, or go back to the home page.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => retry()}
                className="inline-flex h-11 cursor-pointer items-center rounded-full bg-day-blue px-6 font-urbanist text-base text-white transition-colors duration-200 hover:bg-day-blue-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-day-blue"
              >
                Try again
              </button>
              <Link
                href="/"
                className="inline-flex h-11 items-center rounded-full border border-day-line bg-white px-6 font-urbanist text-base text-day-ink transition-colors duration-200 hover:border-day-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-day-blue"
              >
                Go to the home page
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
    </div>
  );
}
