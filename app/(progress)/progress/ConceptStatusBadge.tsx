import { cn } from '@/lib/cn';
import type { ConceptMasteryStatus } from '@/lib/schemas/state-patch';

type ConceptStatusBadgeProps = {
  status: ConceptMasteryStatus;
  escalationActive: boolean;
  lastAttemptResult: 'pass' | 'fail' | null;
};

// Phase 4 (spec 16), the manager's graduation framing: concept areas
// consistently correct are green ("Mastered", status-success); areas that
// are consistently wrong — escalation active, or the latest attempt failed —
// show "Keep iterating" (status-warning) until strengthened. Everything
// else stays a neutral text-muted "Developing". Graduation is concept-area
// based, not a flat percentage.
export function ConceptStatusBadge({ status, escalationActive, lastAttemptResult }: ConceptStatusBadgeProps) {
  if (status === 'mastered') {
    return (
      <span className="inline-block rounded-sm bg-status-success/10 px-2 py-0.5 text-xs font-medium text-status-success">
        Mastered
      </span>
    );
  }

  if (escalationActive || lastAttemptResult === 'fail') {
    return (
      <span className="inline-block rounded-sm bg-status-warning/10 px-2 py-0.5 text-xs font-medium text-status-warning">
        Keep iterating
      </span>
    );
  }

  return <span className={cn('text-xs font-medium text-text-muted')}>Developing</span>;
}
