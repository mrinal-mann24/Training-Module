'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSubmissionStatus } from './useSubmissionStatus';
import { useSubmissionParts } from './useSubmissionParts';
import { getScoringFeedback, getNextExercise, getSubmissionPartsStatus, getSubmissionStatus } from './actions';
import type { SubmissionStatus } from '@/lib/db/queries/submissions';
import type { ValidityError } from '@/lib/tutor/submission-gate';
import { ThinkingIndicator } from './ThinkingIndicator';
import { SubmissionPartsChecklist } from './SubmissionPartsChecklist';
import type { ChatMessage } from './message';
import type { ExerciseForLearner } from '@/lib/db/queries/exercises';
import type { SourceDocumentType } from '@/lib/schemas/source-document';
import type { SubmissionPartType } from '@/lib/schemas/exercise';

type ExerciseSourceDocument = { id: string; docType: SourceDocumentType; documentName: string; url: string };

type PendingSubmissionProps = {
  submissionId: string;
  exerciseId: string;
  // Only exercises with more than one required part (Unit 11) show the live
  // status checklist — a plain two-file exercise keeps Unit 07's single
  // ai-thinking indicator, unchanged.
  requiredParts: SubmissionPartType[];
  onResult: (message: ChatMessage) => void;
  // Called once the mastery recompute + adaptive generation steps
  // (run-scoring.ts) have produced a new exercise — auto-delivers it into
  // the chat the same turn scored feedback appears, per the spec's
  // "the learner doesn't have to ask" requirement.
  onNextExercise: (
    exercise: ExerciseForLearner,
    hintDepth: number,
    moduleNumber: number,
    sourceDocuments: ExerciseSourceDocument[],
  ) => void;
};

// One instance per in-flight submission. Owns the Realtime subscription for
// that submission's row and, once status flips to 'scored', fetches the
// composed feedback via a Server Action — no polling, no manual refresh.
export function PendingSubmission({
  submissionId,
  exerciseId,
  requiredParts,
  onResult,
  onNextExercise,
}: PendingSubmissionProps) {
  const resolvedRef = useRef(false);
  const [initialReceivedParts, setInitialReceivedParts] = useState<SubmissionPartType[] | null>(null);

  const isMultiPart = requiredParts.length > 1;

  useEffect(() => {
    if (!isMultiPart) {
      return;
    }
    let cancelled = false;
    getSubmissionPartsStatus(submissionId).then((result) => {
      if (!cancelled) {
        setInitialReceivedParts(result.receivedParts);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [submissionId, isMultiPart]);

  const receivedParts = useSubmissionParts(submissionId, initialReceivedParts ?? []);

  // Shared by both paths that can observe a terminal status: the Realtime
  // subscription (job finished while the client was listening) and the
  // catch-up read below (job finished before the subscription opened).
  // resolvedRef makes it idempotent, so whichever path observes it first wins
  // and the other is a no-op — the learner never sees a duplicated result.
  const resolveTerminalStatus = useCallback(
    (submissionStatus: SubmissionStatus, validityErrors: ValidityError[] | null) => {
      if (resolvedRef.current) {
        return;
      }

      if (submissionStatus === 'invalid') {
        resolvedRef.current = true;
        const reasons = (validityErrors ?? []).map((error) => `• ${error.message}`).join('\n');
        onResult({
          id: `submission-result-${submissionId}`,
          role: 'assistant',
          kind: 'submission-result-invalid',
          content: `A couple of things need fixing before this can be scored:\n\n${reasons}\n\nFix these in Tally, re-export, and attach the files again.`,
        });
        return;
      }

      if (submissionStatus === 'scored') {
        resolvedRef.current = true;
        getScoringFeedback(submissionId).then((result) => {
          if (result.status !== 'found') {
            return;
          }
          onResult({
            id: `submission-result-${submissionId}`,
            role: 'assistant',
            kind: 'submission-result-scored',
            content: '',
            scoringFeedback: { overallResult: result.overallResult, feedback: result.feedback },
          });

          // 'scored' now flips as soon as feedback is persisted, BEFORE the
          // next exercise finishes generating (batch + source-document PDFs
          // take 60s+; holding feedback until they were done made learners
          // stare at a spinner for ~3 minutes, observed live 2026-08-21).
          // So the next exercise is POLLED for: every few seconds until it
          // lands or the budget runs out. The loop deliberately survives
          // this component unmounting (it unmounts when the feedback message
          // renders) — onNextExercise appends to the still-mounted ChatShell.
          const NEXT_EXERCISE_POLL_MS = 5000;
          // 12 minutes: batch generation on the larger model (plus its
          // guardrail retries and per-document PDFs) can exceed the old
          // 5-minute budget, after which the next exercise silently never
          // auto-arrived (observed live 2026-09-01, a 9m+ production run).
          const NEXT_EXERCISE_POLL_LIMIT = 144;
          function pollNextExercise(attempt: number) {
            getNextExercise(exerciseId).then((nextExerciseResult) => {
              if (nextExerciseResult.status === 'found') {
                onNextExercise(
                  nextExerciseResult.exercise,
                  nextExerciseResult.hintDepth,
                  nextExerciseResult.moduleNumber,
                  nextExerciseResult.sourceDocuments,
                );
                return;
              }
              if (attempt < NEXT_EXERCISE_POLL_LIMIT) {
                setTimeout(() => pollNextExercise(attempt + 1), NEXT_EXERCISE_POLL_MS);
              }
            });
          }
          pollNextExercise(1);
        });
      }
    },
    // onResult/onNextExercise are redefined every ChatShell render (plain
    // function declarations, not memoized); depending on them would re-run
    // the catch-up effect on every parent render. The submission this
    // component owns is identified by submissionId alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [submissionId, exerciseId],
  );

  const status = useSubmissionStatus(submissionId, (row) => {
    resolveTerminalStatus(row.status, row.validity_errors);
  });

  // Catch-up read: the background job can reach a terminal status before the
  // Realtime subscription is open (submitFiles' own upload latency is enough
  // — the job is triggered inside that Server Action, and Postgres Changes
  // only delivers events fired after subscribe()). Without this, a fast job's
  // status update is missed permanently and the UI spins forever on its
  // initial 'validating'. Runs on mount and resolves immediately if the row
  // has already finished; otherwise the subscription handles it normally.
  const [caughtUpStatus, setCaughtUpStatus] = useState<SubmissionStatus | null>(null);

  useEffect(() => {
    // Reset happens here rather than in a separate effect so it cannot race
    // with this effect's own async read: the ref is cleared synchronously
    // before the new read starts, and a stale in-flight read from a previous
    // submissionId is discarded by `cancelled` (which is also what keeps the
    // caughtUpStatus state from needing a synchronous reset here).
    resolvedRef.current = false;

    let cancelled = false;

    function checkStatus() {
      getSubmissionStatus(submissionId).then((result) => {
        if (cancelled || result.status !== 'found') {
          return;
        }
        setCaughtUpStatus(result.submissionStatus);
        resolveTerminalStatus(result.submissionStatus, result.validityErrors);
      });
    }

    checkStatus();

    // Safety-net poll while unresolved. The single mount-time read left a
    // gap observed live (2026-08-20): a fast job can finish AFTER that read
    // but BEFORE the Realtime subscription is fully open — both paths miss
    // the terminal status and the spinner runs forever. Realtime remains the
    // primary signal; this interval only fires while the submission is still
    // pending (resolveTerminalStatus's resolvedRef makes extra hits no-ops),
    // and a background job never legitimately takes long enough for the
    // 5s cadence to matter as load.
    const pollHandle = setInterval(() => {
      if (resolvedRef.current) {
        clearInterval(pollHandle);
        return;
      }
      checkStatus();
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(pollHandle);
    };
  }, [submissionId, resolveTerminalStatus]);

  // The catch-up read wins only while the subscription still reports its
  // initial 'validating' — once Realtime observes a real transition, that is
  // the live value and takes precedence.
  const effectiveStatus = status === 'validating' ? (caughtUpStatus ?? status) : status;
  const isThinking = effectiveStatus === 'validating' || effectiveStatus === 'scoring';

  if (!isThinking) {
    return null;
  }

  if (isMultiPart) {
    return (
      <div className="space-y-2">
        <SubmissionPartsChecklist requiredParts={requiredParts} receivedParts={receivedParts} />
        <ThinkingIndicator />
      </div>
    );
  }

  return <ThinkingIndicator />;
}
