import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { answerLearnerQuestion } from './answer-learner-question';
import type { answerQuestion } from '@/lib/tutor/answer-question';
import type { insertQaMessage } from '@/lib/db/queries/qa-messages';

// Never touched directly: the answer and the history insert are injected.
const supabase = {} as unknown as SupabaseClient;

describe('answerLearnerQuestion', () => {
  it('answers with the scenario as context and saves the exchange', async () => {
    const answer = vi.fn<typeof answerQuestion>().mockResolvedValue({ answer: 'Post it to Bank Charges.' });
    const saveExchange = vi.fn<typeof insertQaMessage>().mockResolvedValue(undefined);

    const result = await answerLearnerQuestion({
      supabase,
      learnerId: 'learner-1',
      question: 'which ledger for bank charges',
      exerciseScenario: 'Blossom Retail, April.',
      deps: { answer, saveExchange },
    });

    expect(result).toEqual({ status: 'answered', answer: 'Post it to Bank Charges.' });
    expect(answer).toHaveBeenCalledWith('learner-1', {
      question: 'which ledger for bank charges',
      exerciseScenario: 'Blossom Retail, April.',
    });
    expect(saveExchange).toHaveBeenCalledWith(supabase, 'learner-1', 'which ledger for bank charges', 'Post it to Bank Charges.');
  });

  it('still returns the answer when saving the exchange fails', async () => {
    const answer = vi.fn<typeof answerQuestion>().mockResolvedValue({ answer: 'Post it to Bank Charges.' });
    const saveExchange = vi.fn<typeof insertQaMessage>().mockRejectedValue(new Error('insert failed'));

    await expect(
      answerLearnerQuestion({ supabase, learnerId: 'learner-1', question: 'q', exerciseScenario: null, deps: { answer, saveExchange } }),
    ).resolves.toEqual({ status: 'answered', answer: 'Post it to Bank Charges.' });
  });

  it('returns the error message when answering fails', async () => {
    const answer = vi.fn<typeof answerQuestion>().mockRejectedValue(new Error('Q&A response failed validation'));
    const saveExchange = vi.fn<typeof insertQaMessage>();

    await expect(
      answerLearnerQuestion({ supabase, learnerId: 'learner-1', question: 'q', exerciseScenario: null, deps: { answer, saveExchange } }),
    ).resolves.toEqual({ status: 'error', error: 'Q&A response failed validation' });
    expect(saveExchange).not.toHaveBeenCalled();
  });
});
