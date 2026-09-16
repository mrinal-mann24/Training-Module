import { describe, expect, it } from 'vitest';
import {
  NO_CONFIRMATION,
  answerConfirmationReducer,
  type AnswerConfirmationEvent,
  type AnswerConfirmationState,
  type AnswerDraft,
} from './answer-confirmation';

const draft: AnswerDraft = {
  exerciseId: 'exercise-1',
  partType: 'explain_text',
  text: 'I posted rent to expenses because it is a monthly cost',
  filesAlreadyIn: false,
};

function run(events: AnswerConfirmationEvent[], start: AnswerConfirmationState = NO_CONFIRMATION) {
  return events.reduce(answerConfirmationReducer, start);
}

describe('answerConfirmationReducer', () => {
  it('opens a card on offer', () => {
    expect(run([{ type: 'offer', draft }])).toEqual({ phase: 'pending', draft });
  });

  it('submits once and ignores a second submit or an ask while in flight', () => {
    expect(run([{ type: 'offer', draft }, { type: 'submit' }, { type: 'submit' }, { type: 'ask' }])).toEqual({
      phase: 'submitting',
      draft,
    });
  });

  it('returns to the choice when the request fails', () => {
    expect(run([{ type: 'offer', draft }, { type: 'submit' }, { type: 'failed' }])).toEqual({ phase: 'pending', draft });
  });

  it('clears the card when a submit or an ask succeeds', () => {
    expect(run([{ type: 'offer', draft }, { type: 'submit' }, { type: 'resolved' }])).toEqual(NO_CONFIRMATION);
    expect(run([{ type: 'offer', draft }, { type: 'ask' }, { type: 'resolved' }])).toEqual(NO_CONFIRMATION);
  });

  it('dismisses a waiting card but never an in-flight one', () => {
    expect(run([{ type: 'offer', draft }, { type: 'dismiss' }])).toEqual(NO_CONFIRMATION);
    expect(run([{ type: 'offer', draft }, { type: 'submit' }, { type: 'dismiss' }])).toEqual({ phase: 'submitting', draft });
  });

  it('ignores submit, ask and resolve when no card is open', () => {
    expect(run([{ type: 'submit' }, { type: 'ask' }, { type: 'resolved' }, { type: 'failed' }])).toEqual(NO_CONFIRMATION);
  });

  it('replaces a waiting card with a newer offer', () => {
    const newer: AnswerDraft = { ...draft, text: 'Freight inward is a direct expense' };
    expect(run([{ type: 'offer', draft }, { type: 'offer', draft: newer }])).toEqual({ phase: 'pending', draft: newer });
  });
});
