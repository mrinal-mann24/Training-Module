import { cn } from '@/lib/cn';
import type { SubmissionPartType } from '@/lib/schemas/exercise';

const PART_LABEL: Record<SubmissionPartType, string> = {
  daybook_xml: 'Daybook',
  trialbalance_xml: 'Trial Balance',
  explain_text: 'Explanation',
  review_text: 'Review',
};

type SubmissionPartsChecklistProps = {
  requiredParts: SubmissionPartType[];
  receivedParts: SubmissionPartType[];
};

// Small status checklist shown while a multi-part submission is incomplete —
// "Daybook ✓ · Trial Balance ✓ · Explanation — waiting", per the spec's
// design note. Only rendered for exercises with more than one required part
// (see PendingSubmission.tsx) — a plain two-file exercise never shows this,
// matching Units 05-07's existing single ai-thinking indicator instead.
export function SubmissionPartsChecklist({ requiredParts, receivedParts }: SubmissionPartsChecklistProps) {
  const receivedSet = new Set(receivedParts);

  return (
    <p className="text-sm text-text-secondary">
      {requiredParts.map((partType, index) => {
        const isReceived = receivedSet.has(partType);
        return (
          <span key={partType}>
            {index > 0 && ' · '}
            {PART_LABEL[partType]}{' '}
            <span className={cn(isReceived ? 'text-status-success' : 'text-text-muted')}>
              {isReceived ? '✓' : '— waiting'}
            </span>
          </span>
        );
      })}
    </p>
  );
}
