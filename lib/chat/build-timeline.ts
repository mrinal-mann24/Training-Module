import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChatMessage } from '@/app/(chat)/chat/message';
import type { ExerciseForLearner } from '@/lib/db/queries/exercises';
import type { Submission } from '@/lib/db/queries/submissions';
import type { FeedbackHistoryRow } from '@/lib/db/queries/scoring-results';
import type { HintRequest } from '@/lib/db/queries/hint-requests';
import type { QaMessage } from '@/lib/db/queries/qa-messages';
import { getExercisesForLearner } from '@/lib/db/queries/exercises';
import { getSubmissionsForLearner } from '@/lib/db/queries/submissions';
import { getFeedbackHistoryForLearner } from '@/lib/db/queries/scoring-results';
import { getHintRequestsForLearner } from '@/lib/db/queries/hint-requests';
import { getQaMessagesForLearner } from '@/lib/db/queries/qa-messages';
import { getSignedPackFileCards } from '@/lib/db/queries/exercise-packs';
import { getSourceDocumentsForExercise, getSignedSourceDocumentUrls } from '@/lib/db/queries/source-documents';
import type { SourceDocumentType } from '@/lib/schemas/source-document';

type SourceDocumentCard = { id: string; docType: SourceDocumentType; documentName: string; url: string };

// Chat-history rebuild (2026-08-24): the conversation must survive a refresh
// like GPT/Claude. Everything except Q&A was already persisted across
// existing tables — this module reassembles it all into the one ordered
// timeline ChatShell renders, on every page load. Nothing here writes;
// messages are DERIVED from the same rows that drive scoring and mastery, so
// history can never drift from what actually happened.

// Pure assembly, exported for tests: rows in → ordered ChatMessage[] out.
export function assembleTimeline(rows: {
  exercises: ExerciseForLearner[];
  submissions: Submission[];
  feedbacks: FeedbackHistoryRow[];
  hints: HintRequest[];
  qaMessages: QaMessage[];
  sourceDocumentsByExercise: Map<string, SourceDocumentCard[]>;
  currentModuleNumber: number;
}): ChatMessage[] {
  type TimelineEvent = { at: string; order: number; message: ChatMessage };
  const events: TimelineEvent[] = [];

  for (const exercise of rows.exercises) {
    const itemLines =
      exercise.reviewPacketItems.length > 0
        ? exercise.reviewPacketItems.map((item) => `${item.sequence}. ${item.presented_text}`).join('\n')
        : exercise.transactions.map((transaction) => `${transaction.sequence}. ${transaction.description}`).join('\n');
    const sourceDocuments = rows.sourceDocumentsByExercise.get(exercise.id) ?? [];
    events.push({
      at: exercise.created_at,
      order: 0,
      message: {
        id: `exercise-${exercise.id}`,
        role: 'assistant',
        kind: 'exercise',
        content: itemLines ? `${exercise.scenario}\n\n${itemLines}` : exercise.scenario,
        // Historical module numbers aren't stored (module is a derived
        // progress value); the current number is a close-enough label for
        // history and exact for the latest exercise.
        progressLabel: `Module ${rows.currentModuleNumber} · Level ${exercise.difficulty_level.replace('L', '')}`,
        sourceDocuments: sourceDocuments.length > 0 ? sourceDocuments : undefined,
      },
    });
  }

  const feedbackBySubmission = new Map(rows.feedbacks.map((row) => [row.submission_id, row]));

  for (const submission of rows.submissions) {
    const attachmentNames = [submission.daybook_filename, submission.trialbalance_filename].filter(
      (name): name is string => name !== null,
    );
    events.push({
      at: submission.created_at,
      order: 1,
      message: {
        id: `submission-${submission.id}`,
        role: 'learner',
        kind: 'submission',
        content: 'Submitted for review.',
        attachmentNames:
          attachmentNames.length > 0
            ? attachmentNames
            : submission.daybook_path
              ? ['Day Book.xml', 'Trial Balance.xml']
              : undefined,
      },
    });

    if (submission.status === 'invalid') {
      const reasons = (submission.validity_errors ?? []).map((error) => `• ${error.message}`).join('\n');
      events.push({
        at: submission.created_at,
        order: 2,
        message: {
          id: `submission-result-${submission.id}`,
          role: 'assistant',
          kind: 'submission-result-invalid',
          content: `A couple of things need fixing before this can be scored:\n\n${reasons}\n\nFix these in Tally, re-export, and attach the files again.`,
        },
      });
    }

    const feedback = feedbackBySubmission.get(submission.id);
    if (feedback) {
      events.push({
        at: feedback.created_at,
        order: 2,
        message: {
          id: `submission-result-${submission.id}`,
          role: 'assistant',
          kind: 'submission-result-scored',
          content: '',
          scoringFeedback: { overallResult: feedback.overall_result, feedback: feedback.feedback_text },
        },
      });
    }
  }

  for (const hint of rows.hints) {
    events.push({
      at: hint.created_at,
      order: 1,
      message: {
        id: `hint-${hint.id}`,
        role: 'assistant',
        kind: 'hint',
        content: hint.hint_content.hint_text,
        hint: hint.hint_content,
      },
    });
  }

  for (const qa of rows.qaMessages) {
    events.push({
      at: qa.created_at,
      order: 1,
      message: { id: `qa-q-${qa.id}`, role: 'learner', kind: 'qa-question', content: qa.question },
    });
    events.push({
      at: qa.created_at,
      order: 2,
      message: { id: `qa-a-${qa.id}`, role: 'assistant', kind: 'qa-answer', content: qa.answer },
    });
  }

  events.sort((a, b) => {
    const byTime = a.at.localeCompare(b.at);
    return byTime !== 0 ? byTime : a.order - b.order;
  });

  return events.map((event) => event.message);
}

// Server-side load-everything wrapper used by the chat page. Uses the
// authenticated client throughout, so every read is RLS-scoped to the
// learner and every signed URL goes through the same policies as live
// delivery.
export async function buildChatTimeline(
  supabase: SupabaseClient,
  learnerId: string,
  currentModuleNumber: number,
): Promise<ChatMessage[]> {
  const [exercises, submissions, feedbacks, hints, qaMessages] = await Promise.all([
    getExercisesForLearner(supabase, learnerId),
    getSubmissionsForLearner(supabase, learnerId),
    getFeedbackHistoryForLearner(supabase, learnerId),
    getHintRequestsForLearner(supabase, learnerId),
    getQaMessagesForLearner(supabase, learnerId),
  ]);

  const sourceDocumentsByExercise = new Map<string, SourceDocumentCard[]>();
  await Promise.all(
    exercises.map(async (exercise) => {
      if (exercise.packFiles.length > 0) {
        sourceDocumentsByExercise.set(exercise.id, await getSignedPackFileCards(supabase, exercise.packFiles));
        return;
      }
      const documents = await getSourceDocumentsForExercise(supabase, exercise.id);
      if (documents.length > 0) {
        sourceDocumentsByExercise.set(exercise.id, await getSignedSourceDocumentUrls(supabase, documents));
      }
    }),
  );

  return assembleTimeline({
    exercises,
    submissions,
    feedbacks,
    hints,
    qaMessages,
    sourceDocumentsByExercise,
    currentModuleNumber,
  });
}
