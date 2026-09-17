import { describe, expect, it } from 'vitest';
import { buildHintPrompt, summarizePackAnswerKey, type HintPromptContext } from './hint';
import { buildHintFacts, chooseHintConcept } from '@/lib/tutor/generate-hint';
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

function contextFor(packMode: boolean): HintPromptContext {
  return {
    rung: 3,
    scenario: 'A month of Blossom Retail bookkeeping.',
    transactions: [],
    answerKey,
    packMode,
    focusConceptTag: 'gst_classification',
  };
}

function promptText(context: HintPromptContext): string {
  const concept = chooseHintConcept(context);
  const { messages } = buildHintPrompt(context, buildHintFacts(context, concept), concept);
  return messages.map((message) => message.content).join('\n');
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
    const fullPrompt = promptText(contextFor(true));
    expect(fullPrompt).not.toContain('Ludhiana Woodworks');
    expect(fullPrompt).not.toContain('1,12,100');
    expect(fullPrompt).not.toContain('112100');
    expect(fullPrompt).not.toContain('INV-010');
    expect(fullPrompt).toContain('PACK MODE');
    expect(fullPrompt).toContain('[R13]');
  });

  it('non-pack mode passes only the focus concept transactions as cited facts, never raw key JSON', () => {
    const fullPrompt = promptText(contextFor(false));
    expect(fullPrompt).toContain('[K1] Transaction 1, bill reference INV-010: Sales voucher. Dr Ludhiana Woodworks Rs 1,12,100 (GST head IGST at 18%).');
    expect(fullPrompt).not.toContain('Karnataka Emporium');
    expect(fullPrompt).not.toContain('"correct_account"');
    expect(fullPrompt).not.toContain('PACK MODE');
  });

  it('fences the facts and carries no em dash from the rulebook', () => {
    const fullPrompt = promptText(contextFor(false));
    expect(fullPrompt).toMatch(/<<<FACTS[\s\S]*FACTS>>>/);
    const facts = buildHintFacts(contextFor(false), 'gst_classification');
    expect(facts.map((fact) => fact.text).join(' ')).not.toMatch(/[—–]/);
  });
});
