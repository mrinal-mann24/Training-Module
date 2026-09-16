import { cn } from '@/lib/cn';

type ProgressBarProps = {
  /** 0-100. Clamped, so a bad caller can never paint outside the track. */
  percent: number;
  /** What the bar measures, for screen readers. Not rendered. */
  label: string;
  className?: string;
};

// The one bar in the product (2026-09-16). It measures how far through the
// material a learner is, which is why it survived the same change that took
// percentages off batch feedback: this number is a position, not a mark.
//
// Tokens only: bg-day-line and bg-day-blue resolve through :root variables,
// so the bar reads the same on every day-surface route (dashboard, progress)
// without a second variant.
//
// The width is an inline style on purpose: code-standards rule 24 names "a
// computed progress-bar width" as the example of a value that cannot be a
// class.
export function ProgressBar({ percent, label, className }: ProgressBarProps) {
  const safePercent = Math.min(100, Math.max(0, Math.round(percent)));

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={safePercent}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-day-line', className)}
    >
      <div
        className="h-full rounded-full bg-day-blue transition-[width] duration-500 motion-reduce:transition-none"
        style={{ width: `${safePercent}%` }}
      />
    </div>
  );
}
