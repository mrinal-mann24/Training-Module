// Unit 14R wiring: decides which KIND of exercise the adaptive loop generates
// next. Unit 11 built 'explain' and 'review' exercises but nothing ever
// scheduled them — generate-review-exercise.ts was unreachable code until
// this selector was wired into run-scoring.ts (2026-08-19).
//
// ASSUMPTION (flagged per ai-workflow-rules.md rule 14 — confirm/adjust the
// cadence with the user): mirrors the pilot programme's arc, where plain
// posting batches came first, an explain/review part arrived around batch 4,
// and review-style judgment work only once the company had real history to
// review. Cadence, counting the diagnostic as exercise 1:
//   - every 5th exercise is a 'review' (open ledger review), provided the
//     learner's company has at least MIN_LOG_ENTRIES_FOR_REVIEW transactions
//     logged to build a packet from;
//   - otherwise every 3rd exercise is an 'explain' (posting + explain-the-
//     entry part);
//   - everything else is a plain 'adaptive' posting batch.
export const MIN_LOG_ENTRIES_FOR_REVIEW = 4;

export type SchedulableExerciseKind = 'adaptive' | 'explain' | 'review';

export function selectNextExerciseKind(params: {
  // How many exercises the learner already has (diagnostic included) — the
  // one being generated is number priorExerciseCount + 1.
  priorExerciseCount: number;
  companyTransactionLogCount: number;
}): SchedulableExerciseKind {
  const nextNumber = params.priorExerciseCount + 1;

  if (nextNumber % 5 === 0 && params.companyTransactionLogCount >= MIN_LOG_ENTRIES_FOR_REVIEW) {
    return 'review';
  }
  if (nextNumber % 3 === 0) {
    return 'explain';
  }
  return 'adaptive';
}
