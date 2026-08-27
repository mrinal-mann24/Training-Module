import { describe, expect, it } from 'vitest';
import { buildHintPrompt, summarizePackAnswerKey } from './hint';
import type { AnswerKey } from '@/lib/schemas/exercise';

const answerKey: AnswerKey = {
  entries: [
    {
      sequence: 1,
      correct_account: 'Ludhiana Woodworks',
      dr_cr: 'Dr',
      amount: 112100,
      voucher_type: 'Sales',
      gst_head: 'IGST',
      gst_rate: 18,
      tds_section: null,
      tds_rate: null,
      tds_base: null,
      bill_reference: 'INV-010',
      narration: 'x',
      concept_tags: ['sales_voucher_basics', 'gst_classification'],
      requires_source_document: false,
      source_document_type: null,
    },
    {
      sequence: 2,
      correct_account: 'Karnataka Emporium',
      dr_cr: 'Dr',
      amount: 45000,
      voucher_type: 'Receipt',
      gst_head: null,
      gst_rate: null,
      tds_section: null,
      tds_rate: null,
      tds_base: null,
      bill_reference: null,
      narration: 'x',
      concept_tags: ['receipt_voucher_basics'],
      requires_source_document: false,
      source_document_type: null,
    },
  ],
};

function contextFor(packMode: boolean) {
  return {
    rung: 3 as const,
    scenario: 'A month of Blossom Retail bookkeeping.',
    transactions: [],
    answerKey,
    packMode,
  };
}

describe('pack-mode hints (answer-key withholding)', () => {
  it('summarizes the key to counts and concept areas only', () => {
    expect(summarizePackAnswerKey(answerKey)).toEqual({
      transaction_count: 2,
      voucher_types: { Sales: 1, Receipt: 1 },
      concept_areas: ['gst_classification', 'receipt_voucher_basics', 'sales_voucher_basics'],
    });
  });

  it('pack mode withholds every party name, amount, and reference from the prompt', () => {
    const { messages } = buildHintPrompt(contextFor(true));
    const fullPrompt = messages.map((message) => message.content).join('\n');
    expect(fullPrompt).not.toContain('Ludhiana Woodworks');
    expect(fullPrompt).not.toContain('112100');
    expect(fullPrompt).not.toContain('INV-010');
    expect(fullPrompt).toContain('PACK MODE');
    expect(fullPrompt).toContain('transaction_count');
  });

  it('non-pack mode still passes the full answer key for grounding', () => {
    const { messages } = buildHintPrompt(contextFor(false));
    const fullPrompt = messages.map((message) => message.content).join('\n');
    expect(fullPrompt).toContain('Ludhiana Woodworks');
    expect(fullPrompt).not.toContain('PACK MODE');
  });
});
