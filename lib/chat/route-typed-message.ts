import type { SupabaseClient } from '@supabase/supabase-js';
import { getLatestExercise, type ExerciseForLearner } from '@/lib/db/queries/exercises';
import { getOpenSubmissionForExercise, hasScoredSubmissionForExercise } from '@/lib/db/queries/submissions';
import { getSubmissionParts } from '@/lib/db/queries/submission-parts';
import type { SubmissionPartType, TextPartType } from '@/lib/schemas/exercise';
import { ASK_QUESTION_INVALID_MESSAGE, AskQuestionInputSchema } from '@/lib/schemas/chat-actions';
import { textPartTypeFor } from '@/lib/tutor/submission-routing';
import { classifyByRules } from '@/lib/chat/message-intent-rules';
import { answerLearnerQuestion } from '@/lib/chat/answer-learner-question';

export type RoutableExercise = Pick<ExerciseForLearner, 'id' | 'scenario' | 'requiredParts'>;

export type RouteTypedMessageResult =
  | { status: 'answered'; answer: string }
  | { status: 'needs-confirmation'; exerciseId: string; partType: TextPartType; text: string }
  | { status: 'error'; error: string };

// A typed part is still owed only if the exercise asks for one, nothing for
// the exercise has been scored yet, and that part has not already arrived.
export function pendingTextPartFrom(
  requiredParts: readonly SubmissionPartType[],
  alreadyScored: boolean,
  receivedParts: readonly SubmissionPartType[],
): TextPartType | null {
  const partType = textPartTypeFor(requiredParts);
  if (!partType || alreadyScored || receivedParts.includes(partType)) {
    return null;
  }
  return partType;
}

export async function findPendingTextPart(
  supabase: SupabaseClient,
  learnerId: string,
  exercise: RoutableExercise,
): Promise<TextPartType | null> {
  if (!textPartTypeFor(exercise.requiredParts)) {
    return null;
  }
  const [alreadyScored, openSubmission] = await Promise.all([
    hasScoredSubmissionForExercise(supabase, learnerId, exercise.id),
    getOpenSubmissionForExercise(supabase, learnerId, exercise.id),
  ]);
  const receivedParts = openSubmission
    ? (await getSubmissionParts(supabase, openSubmission.id)).map((part) => part.part_type)
    : [];
  return pendingTextPartFrom(exercise.requiredParts, alreadyScored, receivedParts);
}

export type RouteTypedMessageDeps = {
  loadExercise?: (supabase: SupabaseClient, learnerId: string) => Promise<RoutableExercise | null>;
  findPendingPart?: typeof findPendingTextPart;
  answer?: typeof answerLearnerQuestion;
};

export type RouteTypedMessageParams = {
  supabase: SupabaseClient;
  learnerId: string;
  // Validated and trimmed by the action (SendTypedMessageInputSchema).
  text: string;
  deps?: RouteTypedMessageDeps;
};

/**
 * Smart Send (2026-09-15): one Send button for everything a learner types.
 *
 * - No typed part owed: the text is a question and is answered here.
 * - A typed part owed: only text the rules call a CLEAR question is answered
 *   directly. Everything else, a clear answer or anything the rules cannot
 *   call, comes back as "needs-confirmation" and NOTHING is written: the
 *   learner taps Submit answer (which calls submitTextPart) or "It's a
 *   question" (which answers it). A misrouted message can therefore never
 *   reach scoring on its own (invariant 2).
 *
 * Why unclear text gets the card (2026-09-16). It used to go to an LLM
 * tie-break that returned 'question' both as a real verdict and as the
 * fallback on every timeout, invalid output or error, on the reasoning that
 * "an answer locks the exercise". That premise was false: the card already
 * makes an answer verdict reversible. The asymmetry runs the other way. A
 * wrong card costs one tap on "It's a question". A wrong question verdict
 * loses the explanation outright, because a Q&A reply offers no way back and
 * submitTextPart is reachable only from the card. Live, "1. Put the entry in
 * the GST" and "Entry is done" were both answered as questions and could
 * never be filed. The LLM tie-break was removed with this change.
 */
export async function routeTypedMessage({
  supabase,
  learnerId,
  text,
  deps = {},
}: RouteTypedMessageParams): Promise<RouteTypedMessageResult> {
  const loadExercise = deps.loadExercise ?? getLatestExercise;
  const findPendingPart = deps.findPendingPart ?? findPendingTextPart;
  const answer = deps.answer ?? answerLearnerQuestion;

  const exercise = await loadExercise(supabase, learnerId);
  const pendingPart = exercise ? await findPendingPart(supabase, learnerId, exercise) : null;

  if (exercise && pendingPart && classifyByRules(text, pendingPart).intent !== 'question') {
    return { status: 'needs-confirmation', exerciseId: exercise.id, partType: pendingPart, text };
  }

  const question = AskQuestionInputSchema.safeParse({ question: text });
  if (!question.success) {
    return { status: 'error', error: ASK_QUESTION_INVALID_MESSAGE };
  }
  return answer({
    supabase,
    learnerId,
    question: question.data.question,
    exerciseScenario: exercise?.scenario ?? null,
  });
}
