import { useId } from 'react';
import type { TextPartType } from '@/lib/schemas/exercise';
import { TEXT_PART_LABEL } from '@/lib/chat/text-part-labels';

type AnswerConfirmationProps = {
  partType: TextPartType;
  filesAlreadyIn: boolean;
  phase: 'pending' | 'submitting' | 'asking';
  // The card's exercise is no longer the current one: say so, offer nothing.
  stale: boolean;
  onSubmit: () => void;
  onAsk: () => void;
};

const BUTTON_FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-day-blue';

/**
 * Smart Send's one question before a typed answer is filed for scoring. It
 * sits in the timeline as a tutor bubble under the learner's message. Nothing
 * takes focus on arrival, so a second Enter in the composer can never submit.
 */
export function AnswerConfirmation({ partType, filesAlreadyIn, phase, stale, onSubmit, onAsk }: AnswerConfirmationProps) {
  const promptId = useId();
  const busy = phase !== 'pending';

  if (stale) {
    return (
      <div className="flex w-full justify-start" aria-live="polite">
        <p className="max-w-[80%] rounded-panel bg-day-card px-6 py-5 font-nunito text-base leading-relaxed text-day-muted">
          Not sent. That answer was for your previous exercise.
        </p>
      </div>
    );
  }

  return (
    <div className="flex w-full justify-start" aria-live="polite">
      <div
        role="group"
        aria-labelledby={promptId}
        className="max-w-[80%] rounded-panel bg-day-card px-6 py-5 font-nunito text-base leading-relaxed text-day-ink"
      >
        <p id={promptId}>
          {filesAlreadyIn ? 'Your files are in. ' : ''}Send this as your {TEXT_PART_LABEL[partType]}? It will be scored.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy}
            aria-busy={phase === 'submitting'}
            className={`inline-flex h-10 items-center rounded-full bg-day-blue px-5 font-urbanist text-sm text-white hover:bg-day-blue-hover disabled:cursor-not-allowed disabled:opacity-60 ${BUTTON_FOCUS}`}
          >
            {phase === 'submitting' ? 'Submitting…' : 'Submit answer'}
          </button>
          <button
            type="button"
            onClick={onAsk}
            disabled={busy}
            aria-busy={phase === 'asking'}
            className={`inline-flex h-10 items-center rounded-full border border-day-line bg-white px-5 font-urbanist text-sm text-day-ink hover:border-day-blue hover:text-day-blue disabled:cursor-not-allowed disabled:opacity-60 ${BUTTON_FOCUS}`}
          >
            {phase === 'asking' ? 'Asking…' : "It's a question"}
          </button>
        </div>
      </div>
    </div>
  );
}
