import type { SupabaseClient } from '@supabase/supabase-js';
import { getLatestExercise, type ExerciseForLearner } from '@/lib/db/queries/exercises';
import { getOpenSubmissionForExercise, hasScoredSubmissionForExercise } from '@/lib/db/queries/submissions';
import { getSubmissionParts } from '@/lib/db/queries/submission-parts';
import type { SubmissionPartType, TextPartType } from '@/lib/schemas/exercise';
import { ASK_QUESTION_INVALID_MESSAGE, AskQuestionInputSchema } from '@/lib/schemas/chat-actions';
import { textPartTypeFor } from '@/lib/tutor/submission-routing';
import { classifyMessageIntent } from '@/lib/tutor/classify-message-intent';
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
  classify?: typeof classifyMessageIntent;
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
 * - A typed part owed: rules decide first, the LLM only breaks ties, and any
 *   classifier failure counts as a question. A question is answered; an
 *   answer comes back as "needs-confirmation" and NOTHING is written: the
 *   learner taps Submit answer, which calls submitTextPart as before. So a
 *   misrouted message can never reach scoring on its own (invariant 2), and
 *   the classifier never sees the answer key (invariant 1).
 */
export async function routeTypedMessage({
  supabase,
  learnerId,
  text,
  deps = {},
}: RouteTypedMessageParams): Promise<RouteTypedMessageResult> {
  const loadExercise = deps.loadExercise ?? getLatestExercise;
  const findPendingPart = deps.findPendingPart ?? findPendingTextPart;
  const classify = deps.classify ?? classifyMessageIntent;
  const answer = deps.answer ?? answerLearnerQuestion;

  const exercise = await loadExercise(supabase, learnerId);
  const pendingPart = exercise ? await findPendingPart(supabase, learnerId, exercise) : null;

  if (exercise && pendingPart) {
    const byRules = classifyByRules(text, pendingPart);
    const intent =
      byRules.intent === 'unclear'
        ? (await classify(learnerId, { text, expectedPart: pendingPart, exerciseScenario: exercise.scenario })).intent
        : byRules.intent;

    if (intent === 'answer') {
      return { status: 'needs-confirmation', exerciseId: exercise.id, partType: pendingPart, text };
    }
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
