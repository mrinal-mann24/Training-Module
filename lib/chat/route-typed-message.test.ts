import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  pendingTextPartFrom,
  routeTypedMessage,
  type RoutableExercise,
  type RouteTypedMessageDeps,
} from './route-typed-message';
import { ASK_QUESTION_INVALID_MESSAGE } from '@/lib/schemas/chat-actions';

// Never touched directly: every query and call is injected.
const supabase = {} as unknown as SupabaseClient;

const exercise: RoutableExercise = {
  id: 'exercise-1',
  scenario: 'Blossom Retail, April. Explain the entries you posted.',
  requiredParts: ['daybook_xml', 'trialbalance_xml', 'explain_text'],
};

function makeDeps(overrides: Partial<Required<RouteTypedMessageDeps>> = {}) {
  return {
    loadExercise: vi.fn<Required<RouteTypedMessageDeps>['loadExercise']>().mockResolvedValue(exercise),
    findPendingPart: vi.fn<Required<RouteTypedMessageDeps>['findPendingPart']>().mockResolvedValue('explain_text'),
    classify: vi
      .fn<Required<RouteTypedMessageDeps>['classify']>()
      .mockResolvedValue({ intent: 'question', source: 'llm' }),
    answer: vi
      .fn<Required<RouteTypedMessageDeps>['answer']>()
      .mockResolvedValue({ status: 'answered', answer: 'Post it to Bank Charges.' }),
    ...overrides,
  };
}

describe('routeTypedMessage', () => {
  it('answers straight away when no typed part is owed', async () => {
    const deps = makeDeps({ findPendingPart: vi.fn().mockResolvedValue(null) });

    const result = await routeTypedMessage({ supabase, learnerId: 'learner-1', text: 'I posted rent because it is monthly', deps });

    expect(result).toEqual({ status: 'answered', answer: 'Post it to Bank Charges.' });
    expect(deps.classify).not.toHaveBeenCalled();
    expect(deps.answer).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'I posted rent because it is monthly', exerciseScenario: exercise.scenario }),
    );
  });

  it('answers with no scenario when there is no exercise', async () => {
    const deps = makeDeps({ loadExercise: vi.fn().mockResolvedValue(null) });

    await routeTypedMessage({ supabase, learnerId: 'learner-1', text: 'what is TDS', deps });

    expect(deps.findPendingPart).not.toHaveBeenCalled();
    expect(deps.answer).toHaveBeenCalledWith(expect.objectContaining({ exerciseScenario: null }));
  });

  it('answers a clear question without calling the LLM', async () => {
    const deps = makeDeps();

    await expect(
      routeTypedMessage({ supabase, learnerId: 'learner-1', text: 'which ledger for bank charges', deps }),
    ).resolves.toEqual({ status: 'answered', answer: 'Post it to Bank Charges.' });
    expect(deps.classify).not.toHaveBeenCalled();
  });

  it('asks for confirmation on a clear answer and writes nothing', async () => {
    const deps = makeDeps();
    const text = 'I posted rent to expenses because it is a monthly cost, not an asset';

    await expect(routeTypedMessage({ supabase, learnerId: 'learner-1', text, deps })).resolves.toEqual({
      status: 'needs-confirmation',
      exerciseId: 'exercise-1',
      partType: 'explain_text',
      text,
    });
    expect(deps.classify).not.toHaveBeenCalled();
    expect(deps.answer).not.toHaveBeenCalled();
  });

  it('breaks a tie with the LLM and confirms when it says answer', async () => {
    const deps = makeDeps({ classify: vi.fn().mockResolvedValue({ intent: 'answer', source: 'llm' }) });
    const text = 'Bank charges go under Indirect Expenses';

    const result = await routeTypedMessage({ supabase, learnerId: 'learner-1', text, deps });

    expect(result.status).toBe('needs-confirmation');
    expect(deps.classify).toHaveBeenCalledWith('learner-1', {
      text,
      expectedPart: 'explain_text',
      exerciseScenario: exercise.scenario,
    });
  });

  it('treats a classifier fallback as a question', async () => {
    const deps = makeDeps({
      classify: vi.fn().mockResolvedValue({ intent: 'question', source: 'fallback', fallback: 'timeout' }),
    });

    await expect(
      routeTypedMessage({ supabase, learnerId: 'learner-1', text: 'Bank charges go under Indirect Expenses', deps }),
    ).resolves.toEqual({ status: 'answered', answer: 'Post it to Bank Charges.' });
  });

  it('refuses a question longer than Q&A accepts', async () => {
    const deps = makeDeps({ findPendingPart: vi.fn().mockResolvedValue(null) });

    await expect(
      routeTypedMessage({ supabase, learnerId: 'learner-1', text: 'x'.repeat(2500), deps }),
    ).resolves.toEqual({ status: 'error', error: ASK_QUESTION_INVALID_MESSAGE });
    expect(deps.answer).not.toHaveBeenCalled();
  });
});

describe('pendingTextPartFrom', () => {
  it('owes nothing on a files-only exercise', () => {
    expect(pendingTextPartFrom(['daybook_xml', 'trialbalance_xml'], false, [])).toBeNull();
  });

  it('owes nothing once the exercise is scored', () => {
    expect(pendingTextPartFrom(['review_text'], true, [])).toBeNull();
  });

  it('owes nothing once the part has arrived', () => {
    expect(pendingTextPartFrom(['daybook_xml', 'trialbalance_xml', 'explain_text'], false, ['explain_text'])).toBeNull();
  });

  it('owes the review on an unanswered review exercise', () => {
    expect(pendingTextPartFrom(['review_text'], false, [])).toBe('review_text');
  });
});
