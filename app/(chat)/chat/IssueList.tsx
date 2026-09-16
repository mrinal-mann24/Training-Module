import { cn } from '@/lib/cn';
import type { LearnerIssue } from '@/lib/db/queries/learner-issues';

const WHEN_FORMAT = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

function formatWhen(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return Number.isNaN(date.getTime()) ? '' : WHEN_FORMAT.format(date);
}

type IssueListProps = {
  issues: LearnerIssue[];
};

// Presentational: the learner's own issues, newest first, with status and the
// owner's reply once there is one. Text renders as plain React text (never as
// HTML), with line breaks kept and long unbroken strings wrapped.
export function IssueList({ issues }: IssueListProps) {
  if (issues.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby="your-issues-title" className="mt-6 border-t border-day-line pt-4">
      <h3 id="your-issues-title" className="text-sm font-semibold text-day-ink">
        Your issues
      </h3>
      <ul className="mt-3 max-h-72 space-y-3 overflow-y-auto pr-1">
        {issues.map((issue) => {
          const resolved = issue.status === 'resolved';
          return (
            <li key={issue.id} className="rounded-2xl border border-day-line p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-day-muted">{formatWhen(issue.created_at)}</span>
                <span
                  className={cn(
                    'rounded-full border px-2 py-0.5 font-urbanist text-xs font-medium',
                    resolved ? 'border-status-success text-status-success' : 'border-status-warning text-status-warning',
                  )}
                >
                  {resolved ? 'Resolved' : 'Open'}
                </span>
              </div>
              <p className="mt-2 whitespace-pre-wrap wrap-break-word text-sm text-day-ink">{issue.message}</p>
              {issue.admin_reply && (
                <div className="mt-2 rounded-xl bg-day-card px-3 py-2">
                  <p className="text-xs font-medium text-day-muted">Reply</p>
                  <p className="mt-1 whitespace-pre-wrap wrap-break-word text-sm text-day-ink">{issue.admin_reply}</p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
