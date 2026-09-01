import { cn } from '@/lib/cn';
import type { OverallResult } from '@/lib/schemas/scoring';
import type { ChatMessage } from './message';
import { DocumentCard } from './DocumentCard';

type MessageBubbleProps = {
  message: ChatMessage;
};

const RESULT_BADGE_STYLES: Record<OverallResult, string> = {
  pass: 'bg-status-success/10 text-status-success',
  partial: 'bg-status-warning/10 text-status-warning',
  fail: 'bg-status-error/10 text-status-error',
};

const RESULT_BADGE_LABELS: Record<OverallResult, string> = {
  pass: 'Pass',
  partial: 'Partial',
  fail: 'Needs work',
};

export function MessageBubble({ message }: MessageBubbleProps) {
  const isLearner = message.role === 'learner';
  const isInvalidResult = message.kind === 'submission-result-invalid';
  const scoringFeedback = message.scoringFeedback;
  const hint = message.hint;

  return (
    <div className={cn('flex w-full', isLearner ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] whitespace-pre-wrap rounded-lg px-4 py-3 text-base leading-[1.4]',
          isLearner ? 'bg-bg-user-bubble text-text-primary' : 'bg-bg-surface text-text-primary',
        )}
      >
        {message.progressLabel && (
          <span className="mb-2 mr-2 inline-block rounded-sm bg-bg-canvas px-2 py-0.5 text-xs font-medium text-text-secondary">
            {message.progressLabel}
          </span>
        )}
        {isInvalidResult && (
          <span className="mr-2 inline-block rounded-sm bg-status-error/10 px-2 py-0.5 text-xs font-medium text-status-error">
            Needs a fix
          </span>
        )}
        {scoringFeedback && (
          <div className="space-y-3">
            <span
              className={cn(
                'inline-block rounded-sm px-2 py-0.5 text-xs font-medium',
                RESULT_BADGE_STYLES[scoringFeedback.overallResult],
              )}
            >
              {RESULT_BADGE_LABELS[scoringFeedback.overallResult]}
            </span>
            <p className="font-bold">{scoringFeedback.feedback.opening_line}</p>
            {scoringFeedback.feedback.went_well.length > 0 && (
              <div>
                <p className="text-lg font-medium">What went well</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {scoringFeedback.feedback.went_well.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </div>
            )}
            {scoringFeedback.feedback.needs_work.length > 0 && (
              <div>
                <p className="text-lg font-medium">What needs work</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {scoringFeedback.feedback.needs_work.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-text-secondary">{scoringFeedback.feedback.next_note}</p>
          </div>
        )}
        {hint && (
          <div className="space-y-2">
            <span className="inline-block rounded-sm bg-accent-subtle px-2 py-0.5 text-xs font-medium text-accent">
              Help step {Math.min(hint.rung, 3)} of 3
            </span>
            <p>{hint.hint_text}</p>
          </div>
        )}
        {!scoringFeedback && !hint && message.content}
        {message.sourceDocuments && message.sourceDocuments.length > 0 && (
          <div className="mt-3 space-y-2">
            {message.sourceDocuments.map((doc) => (
              <DocumentCard
                key={doc.id}
                documentName={doc.documentName}
                url={doc.url}
                documentId={doc.id}
                // A pack card's id IS its storage path (getSignedPackFileCards);
                // a generated document's id is its table row uuid. The slash
                // is what separates the two, and it decides which bucket the
                // click re-signs against.
                isPackFile={doc.id.includes('/')}
              />
            ))}
          </div>
        )}
        {message.attachmentNames && message.attachmentNames.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {message.attachmentNames.map((name, index) => (
              <span
                key={`${name}-${index}`}
                className="inline-flex items-center gap-1 rounded-sm border border-border-default bg-bg-surface px-2 py-1 font-mono text-xs text-text-secondary"
              >
                {name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
