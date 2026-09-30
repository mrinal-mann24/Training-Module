// What a learner is told after a month is scored and no next month has
// arrived (2026-09-30, production audit). Until now the only answer was
// "your next batch is being prepared and will appear in a minute or two",
// which stayed on screen for ever when generation had failed for good, and
// also when every topic was already mastered and there was nothing to
// prepare. Pure and client-safe: the loaders live in the callers.

export type NextMonthStatus = 'preparing' | 'completed' | 'delayed';

// Generation normally takes one to ten minutes; the chat polls for twelve.
// After this, the run has either failed or is far outside the normal range,
// and either way the learner should stop expecting it any moment.
export const NEXT_MONTH_DELAY_MS = 15 * 60 * 1000;

export const NEXT_MONTH_PREPARING_MESSAGE =
  'This month has already been scored, so I will not take a second upload for it. Your next month is being prepared and will appear here within a few minutes, up to about ten. Refresh the page if it has not shown up.';

export const NEXT_MONTH_DELAYED_MESSAGE =
  'Your next month is taking longer than usual to prepare. This is on our side, not yours, and you do not need to do anything. Refresh the page in a few minutes to see it. If it cannot be prepared at all, your trainer is told automatically.';

export const PROGRAMME_COMPLETE_MESSAGE =
  'You have finished every topic in this programme. Well done. There is no next month to post. Your trainer will tell you what happens next. You can still ask me questions here.';

export function decideNextMonthStatus(params: { scoredAt: string; now: number; programmeComplete: boolean }): NextMonthStatus {
  if (params.programmeComplete) return 'completed';
  const scoredAt = Date.parse(params.scoredAt);
  if (Number.isFinite(scoredAt) && params.now - scoredAt >= NEXT_MONTH_DELAY_MS) return 'delayed';
  return 'preparing';
}

export function nextMonthMessage(status: NextMonthStatus): string {
  if (status === 'completed') return PROGRAMME_COMPLETE_MESSAGE;
  if (status === 'delayed') return NEXT_MONTH_DELAYED_MESSAGE;
  return NEXT_MONTH_PREPARING_MESSAGE;
}
