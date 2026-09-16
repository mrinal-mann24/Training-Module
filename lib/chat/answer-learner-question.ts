import type { SupabaseClient } from '@supabase/supabase-js';
import { answerQuestion } from '@/lib/tutor/answer-question';
import { insertQaMessage } from '@/lib/db/queries/qa-messages';

export type AnswerLearnerQuestionResult =
  | { status: 'answered'; answer: string }
  | { status: 'error'; error: string };

export type AnswerLearnerQuestionParams = {
  supabase: SupabaseClient;
  learnerId: string;
  // Already validated and trimmed by the caller (AskQuestionInputSchema).
  question: string;
  // The active exercise's learner-facing scenario, never the answer key.
  exerciseScenario: string | null;
  // Injected in tests.
  deps?: { answer?: typeof answerQuestion; saveExchange?: typeof insertQaMessage };
};

// Unit 15R free-form Q&A, shared by the askQuestion action and Smart Send
// routing (lib/chat/route-typed-message.ts): answer the question, then persist
// the exchange so it survives a refresh. A failed insert must not eat the
// answer the learner is waiting on; history just won't carry that exchange.
export async function answerLearnerQuestion({
  supabase,
  learnerId,
  question,
  exerciseScenario,
  deps = {},
}: AnswerLearnerQuestionParams): Promise<AnswerLearnerQuestionResult> {
  const answer = deps.answer ?? answerQuestion;
  const saveExchange = deps.saveExchange ?? insertQaMessage;

  try {
    const response = await answer(learnerId, { question, exerciseScenario });
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
