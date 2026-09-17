import type { SupabaseClient } from '@supabase/supabase-js';
import { answerQuestion } from '@/lib/tutor/answer-question';
import { insertQaMessage } from '@/lib/db/queries/qa-messages';
import { getLearnerProfile } from '@/lib/db/queries/learner-profile';
import { getLatestExercise } from '@/lib/db/queries/exercises';
import type { LicenseMode } from '@/lib/schemas/onboarding';

export type AnswerLearnerQuestionResult =
  | { status: 'answered'; answer: string }
  | { status: 'error'; error: string };

export type LearnerQuestionContext = {
  licenseMode: LicenseMode | null;
  transactions: { sequence: number; description: string }[];
};

export type AnswerLearnerQuestionParams = {
  supabase: SupabaseClient;
  learnerId: string;
  // Already validated and trimmed by the caller (AskQuestionInputSchema).
  question: string;
  // The active exercise's learner-facing scenario, never the answer key.
  exerciseScenario: string | null;
  // The active exercise's learner-facing transaction lines and the learner's
  // Tally license (2026-09-17). Callers that already hold them pass them;
  // Smart Send routing does not, so they are loaded here when absent.
  exerciseTransactions?: { sequence: number; description: string }[];
  licenseMode?: LicenseMode | null;
  // Injected in tests.
  deps?: {
    answer?: typeof answerQuestion;
    saveExchange?: typeof insertQaMessage;
    loadContext?: (supabase: SupabaseClient, learnerId: string) => Promise<LearnerQuestionContext>;
  };
};

async function loadQuestionContext(supabase: SupabaseClient, learnerId: string): Promise<LearnerQuestionContext> {
  const [profile, exercise] = await Promise.all([getLearnerProfile(supabase, learnerId), getLatestExercise(supabase, learnerId)]);
  return { licenseMode: profile?.license_mode ?? null, transactions: exercise?.transactions ?? [] };
}

// Unit 15R free-form Q&A, shared by the askQuestion action and Smart Send
// routing (lib/chat/route-typed-message.ts): answer the question, then persist
// the exchange so it survives a refresh. A failed insert must not eat the
// answer the learner is waiting on; history just won't carry that exchange.
export async function answerLearnerQuestion({
  supabase,
  learnerId,
  question,
  exerciseScenario,
  exerciseTransactions,
  licenseMode,
  deps = {},
}: AnswerLearnerQuestionParams): Promise<AnswerLearnerQuestionResult> {
  const answer = deps.answer ?? answerQuestion;
  const saveExchange = deps.saveExchange ?? insertQaMessage;
  const loadContext = deps.loadContext ?? loadQuestionContext;

  try {
    let context: LearnerQuestionContext = { licenseMode: licenseMode ?? null, transactions: exerciseTransactions ?? [] };
    if (exerciseTransactions === undefined || licenseMode === undefined) {
      try {
        const loaded = await loadContext(supabase, learnerId);
        context = {
          licenseMode: licenseMode === undefined ? loaded.licenseMode : licenseMode,
          transactions: exerciseTransactions ?? (exerciseScenario === null ? [] : loaded.transactions),
        };
      } catch {
        // The context only sharpens the checks; an answer still goes out
        // without it.
      }
    }
    const response = await answer(learnerId, {
      question,
      exerciseScenario,
      exerciseTransactions: context.transactions,
      licenseMode: context.licenseMode,
    });
    try {
      await saveExchange(supabase, learnerId, question, response.answer);
    } catch {
      // non-fatal
    }
    return { status: 'answered', answer: response.answer };
  } catch (error) {
    return {
      status: 'error',
      error: error instanceof Error ? error.message : 'Could not answer right now. Please try again.',
    };
  }
}
