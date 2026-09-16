import type { TextPartType } from '@/lib/schemas/exercise';

export type AnswerDraft = {
  exerciseId: string;
  partType: TextPartType;
  // Exactly the text the server routed; the card never lets it change.
  text: string;
  // The message also carried the Day Book and Trial Balance, already accepted.
  filesAlreadyIn: boolean;
};

export type AnswerConfirmationState =
  | { phase: 'none' }
  | { phase: 'pending' | 'submitting' | 'asking'; draft: AnswerDraft };

export type AnswerConfirmationEvent =
  | { type: 'offer'; draft: AnswerDraft }
  | { type: 'submit' }
  | { type: 'ask' }
  | { type: 'failed' }
  | { type: 'resolved' }
  | { type: 'dismiss' };

export const NO_CONFIRMATION: AnswerConfirmationState = { phase: 'none' };

/**
 * Smart Send's "Submit answer / It's a question" card. One card at a time. A
 * draft resolves once: a second Submit or Ask while a request is in flight is
 * ignored, a failed request returns to the choice, and success clears the
 * card. A card still waiting for a choice is dismissed when the learner sends
 * something new or the exercise changes; an in-flight request never is.
 */
export function answerConfirmationReducer(
  state: AnswerConfirmationState,
  event: AnswerConfirmationEvent,
): AnswerConfirmationState {
  switch (event.type) {
    case 'offer':
      return { phase: 'pending', draft: event.draft };
    case 'submit':
      return state.phase === 'pending' ? { phase: 'submitting', draft: state.draft } : state;
    case 'ask':
      return state.phase === 'pending' ? { phase: 'asking', draft: state.draft } : state;
    case 'failed':
      return state.phase === 'submitting' || state.phase === 'asking' ? { phase: 'pending', draft: state.draft } : state;
    case 'resolved':
      return state.phase === 'submitting' || state.phase === 'asking' ? NO_CONFIRMATION : state;
    case 'dismiss':
      return state.phase === 'pending' ? NO_CONFIRMATION : state;
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
}
