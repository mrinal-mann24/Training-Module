import { cn } from '@/lib/cn';
import type { ChatMessage } from '@/lib/chat/message';
import { DocumentCard } from './DocumentCard';

type MessageBubbleProps = {
  message: ChatMessage;
};

// 2026-09-16: the Pass / Partial / Needs work badge was removed. Feedback
// now opens with what the learner did and leads into "What went well" and
// "What needs work" — a verdict chip above those sections told them how to
// feel about the batch before they had read either.

export function MessageBubble({ message }: MessageBubbleProps) {
  const isLearner = message.role === 'learner';
  const isInvalidResult = message.kind === 'submission-result-invalid';
  const scoringFeedback = message.scoringFeedback;
  const hint = message.hint;

  return (
    <div className={cn('flex w-full', isLearner ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] whitespace-pre-wrap rounded-panel px-6 py-5 font-nunito text-base leading-relaxed',
          isLearner ? 'bg-day-blue text-white' : 'bg-day-card text-day-ink',
        )}
      >
        {message.progressLabel && (
          <span className="mb-2 mr-2 inline-block rounded-full bg-white px-3 py-0.5 font-urbanist text-xs font-medium text-day-muted">
            {message.progressLabel}
          </span>
        )}
        {isInvalidResult && (
          <span className="mr-2 inline-block rounded-full bg-status-error/10 px-3 py-0.5 font-urbanist text-xs font-medium text-status-error">
            Needs a fix
          </span>
        )}
        {scoringFeedback && (
          <div className="space-y-3">
            <p className="font-bold">{scoringFeedback.feedback.opening_line}</p>
            {scoringFeedback.feedback.went_well.length > 0 && (
              <div>
                <p className="font-nunito text-lg font-semibold">What went well</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {scoringFeedback.feedback.went_well.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </div>
            )}
            {scoringFeedback.feedback.needs_work.length > 0 && (
              <div>
                <p className="font-nunito text-lg font-semibold">What needs work</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {scoringFeedback.feedback.needs_work.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-day-muted">{scoringFeedback.feedback.next_note}</p>
          </div>
        )}
        {hint && (
          <div className="space-y-2">
            <span className="inline-block rounded-full bg-day-blue/10 px-3 py-0.5 font-urbanist text-xs font-medium text-day-blue">
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
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-3 py-1 font-mono text-xs',
                  isLearner ? 'border-white/25 bg-white/15 text-white' : 'border-day-line bg-white text-day-muted',
                )}
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
