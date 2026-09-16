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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 font-nunito"
    >
      <div className="w-full max-w-xl rounded-panel border border-day-line bg-white p-6 shadow-dashboard">
        <p className="font-urbanist text-xs font-medium uppercase tracking-wide text-day-blue">
          AI Accountant setup · Step {stepIndex + 1} of {AIA_ONBOARDING_STEPS.length}
        </p>
        <h2 id="aia-onboarding-title" className="mt-2 text-xl font-semibold text-day-ink">
          {step.title}
        </h2>

        {step.video && (
          <div className="mt-4">
            <div className="aspect-video w-full overflow-hidden rounded-2xl border border-day-line bg-black">
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
              className="mt-2 inline-block text-sm text-day-blue underline-offset-2 hover:underline"
            >
              Open the video on YouTube
            </a>
          </div>
        )}

        <p className="mt-4 whitespace-pre-line text-base leading-relaxed text-day-muted">{step.body}</p>

        {errorMessage && <p className="mt-3 text-sm text-status-error">{errorMessage}</p>}

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={handleAction}
            disabled={isPending}
            className="inline-flex h-11 items-center rounded-full bg-day-blue px-6 font-urbanist text-base text-white transition-colors hover:bg-day-blue-hover disabled:opacity-60"
          >
            {isPending ? 'Saving…' : step.buttonLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
