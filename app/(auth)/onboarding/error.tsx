'use client';

import { useEffect } from 'react';
import Link from 'next/link';

type OnboardingErrorProps = {
  error: Error & { digest?: string };
  retry: () => void;
};

const PRIMARY_BUTTON_CLASSES =
  'inline-flex h-12 w-full cursor-pointer items-center justify-center rounded-full bg-day-blue font-urbanist text-lg text-white transition-colors duration-200 hover:bg-day-blue-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-day-blue focus-visible:ring-offset-2';

const SECONDARY_BUTTON_CLASSES =
  'inline-flex h-12 w-full items-center justify-center rounded-full border border-day-line bg-white font-urbanist text-lg text-day-ink transition-colors duration-200 hover:bg-day-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-day-blue focus-visible:ring-offset-2';

/**
 * Error boundary for /onboarding, rendered inside the auth shell's `.day`
 * surface (the layout above a segment is outside its error boundary, so the
 * dark pill header stays). It never renders `error.message` (it can carry
 * internal detail). "Try again" calls `retry`, which refreshes the server data
 * before re-rendering; the safe way out is sign in.
 */
export default function OnboardingError({ error, retry }: OnboardingErrorProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  // Next does not guarantee the thrown value is an Error object.
  const digest = error?.digest;

  return (
    <div
      role="alert"
      className="w-full max-w-lg rounded-card border border-day-line bg-day-card p-2.5"
    >
      <div className="rounded-panel bg-white p-8 text-center max-md:p-6">
        <h1 className="day-title font-nunito">
          Something went <em>wrong</em>
        </h1>
        <p className="mt-2 font-nunito text-base leading-relaxed text-day-muted">
          We couldn&apos;t load your workspace setup just now. Try again, or go back to sign in.
        </p>

        <div className="mt-8 flex flex-col gap-3">
          <button type="button" onClick={() => retry()} className={PRIMARY_BUTTON_CLASSES}>
            Try again
          </button>
          <Link href="/login" className={SECONDARY_BUTTON_CLASSES}>
            Back to sign in
          </Link>
        </div>

        {digest && (
          <p className="mt-6 font-nunito text-xs text-day-muted">
            Reference code: <span className="font-mono">{digest}</span>
          </p>
        )}
      </div>
    </div>
  );
}
