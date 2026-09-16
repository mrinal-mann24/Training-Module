'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Wordmark } from '@/app/components/Wordmark';

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
    <div className="day flex h-dvh flex-col">
      <header className="relative z-10 px-4 pt-4 md:px-8">
        <div className="mx-auto flex h-14 max-w-5xl items-center rounded-full bg-day-panel px-6 md:px-10">
          <Wordmark className="font-urbanist" />
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div role="alert" className="w-full max-w-md rounded-card border border-day-line bg-day-card p-2.5">
          <div className="rounded-panel bg-white p-8 text-center">
            <h1 className="day-title font-nunito">
              Something went <em>wrong</em>
            </h1>
            <p className="mt-3 font-nunito text-base leading-relaxed text-day-muted">
              We couldn&apos;t open your chat just now. Try again, and if it keeps happening, head
              back to your dashboard.
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
    </div>
  );
}
