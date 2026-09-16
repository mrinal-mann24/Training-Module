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

const BUTTON_FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

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
        <p className="max-w-[80%] rounded-lg bg-bg-surface px-4 py-3 text-base leading-[1.4] text-text-secondary">
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
        className="max-w-[80%] rounded-lg bg-bg-surface px-4 py-3 text-base leading-[1.4] text-text-primary"
      >
        <p id={promptId}>
          {filesAlreadyIn ? 'Your files are in. ' : ''}Send this as your {TEXT_PART_LABEL[partType]}? It will be scored.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy}
            aria-busy={phase === 'submitting'}
            className={`rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60 ${BUTTON_FOCUS}`}
          >
            {phase === 'submitting' ? 'Submitting…' : 'Submit answer'}
          </button>
          <button
            type="button"
            onClick={onAsk}
            disabled={busy}
            aria-busy={phase === 'asking'}
            className={`rounded-md border border-border-default px-4 py-2 text-sm text-text-secondary hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60 ${BUTTON_FOCUS}`}
          >
            {phase === 'asking' ? 'Asking…' : "It's a question"}
          </button>
        </div>
      </div>
    </div>
  );
}
