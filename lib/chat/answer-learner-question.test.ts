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

    const loadContext = vi.fn();

    const result = await answerLearnerQuestion({
      supabase,
      learnerId: 'learner-1',
      question: 'which ledger for bank charges',
      exerciseScenario: 'Blossom Retail, April.',
      exerciseTransactions: [{ sequence: 1, description: 'Bank charges of Rs 350.' }],
      licenseMode: 'licensed',
      deps: { answer, saveExchange, loadContext },
    });

    expect(result).toEqual({ status: 'answered', answer: 'Post it to Bank Charges.' });
    expect(answer).toHaveBeenCalledWith('learner-1', {
      question: 'which ledger for bank charges',
      exerciseScenario: 'Blossom Retail, April.',
      exerciseTransactions: [{ sequence: 1, description: 'Bank charges of Rs 350.' }],
      licenseMode: 'licensed',
    });
    expect(loadContext).not.toHaveBeenCalled();
    expect(saveExchange).toHaveBeenCalledWith(supabase, 'learner-1', 'which ledger for bank charges', 'Post it to Bank Charges.');
  });

  // Smart Send (route-typed-message.ts) passes only the scenario: the license
  // and transaction lines are loaded so the Educational Mode and
  // current-exercise checks still apply (2026-09-17).
  it('loads the license and transactions when the caller does not pass them', async () => {
    const answer = vi.fn<typeof answerQuestion>().mockResolvedValue({ answer: 'ok' });
    const loadContext = vi.fn().mockResolvedValue({
      licenseMode: 'educational',
      transactions: [{ sequence: 1, description: 'Sold goods for Rs 5,900.' }],
    });

    await answerLearnerQuestion({
      supabase,
      learnerId: 'learner-1',
      question: 'q',
      exerciseScenario: 'Blossom Retail, June.',
      deps: { answer, saveExchange: vi.fn<typeof insertQaMessage>().mockResolvedValue(undefined), loadContext },
    });

    expect(answer).toHaveBeenCalledWith('learner-1', {
      question: 'q',
      exerciseScenario: 'Blossom Retail, June.',
      exerciseTransactions: [{ sequence: 1, description: 'Sold goods for Rs 5,900.' }],
      licenseMode: 'educational',
    });
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
