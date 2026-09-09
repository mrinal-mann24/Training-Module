'use client';

import { useState, useTransition } from 'react';
import { AIA_ONBOARDING_STEPS, AIA_SETUP_VIDEO_EMBED_URL, AIA_SETUP_VIDEO_URL } from './aia-onboarding-config';

type AiaOnboardingProps = {
  // Persists completion; resolves to an error string when it failed.
  onComplete: () => Promise<string | null>;
};

// Modal popup for the one-time AI Accountant setup (documents mode). Steps
// through AIA_ONBOARDING_STEPS with a single button; the last step records
// completion and closes the popup. There is deliberately no close button:
// the learner has to walk through it once, then never sees it again.
export function AiaOnboarding({ onComplete }: AiaOnboardingProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const step = AIA_ONBOARDING_STEPS[stepIndex];
  const isLastStep = stepIndex === AIA_ONBOARDING_STEPS.length - 1;

  function handleAction() {
    if (!isLastStep) {
      setStepIndex((index) => index + 1);
      return;
    }
    setErrorMessage(null);
    startTransition(async () => {
      const error = await onComplete();
      if (error) setErrorMessage(error);
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="aia-onboarding-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 font-body"
    >
      <div className="w-full max-w-xl rounded-2xl border border-border bg-background p-6 shadow-dashboard">
        <p className="text-xs font-medium uppercase tracking-wide text-accent">
          AI Accountant setup · Step {stepIndex + 1} of {AIA_ONBOARDING_STEPS.length}
        </p>
        <h2 id="aia-onboarding-title" className="mt-2 text-xl font-semibold text-foreground">
          {step.title}
        </h2>

        {step.video && (
          <div className="mt-4">
            <div className="aspect-video w-full overflow-hidden rounded-lg border border-border bg-black">
              <iframe
                className="h-full w-full"
                src={AIA_SETUP_VIDEO_EMBED_URL}
                title="AI Accountant setup video"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
            <a
              href={AIA_SETUP_VIDEO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-sm text-accent underline-offset-2 hover:underline"
            >
              Open the video on YouTube
            </a>
          </div>
        )}

        <p className="mt-4 whitespace-pre-line text-base leading-relaxed text-text-secondary">{step.body}</p>

        {errorMessage && <p className="mt-3 text-sm text-status-error">{errorMessage}</p>}

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={handleAction}
            disabled={isPending}
            className="rounded-md bg-accent px-5 py-2 text-base text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {isPending ? 'Saving…' : step.buttonLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
