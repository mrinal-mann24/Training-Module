import { describe, expect, it, vi } from 'vitest';
import type { HintPromptContext } from '@/lib/llm/prompts/hint';
import type { AnswerKey, AnswerKeyEntry } from '@/lib/schemas/exercise';
import { CONCEPT_TAGS } from '@/lib/schemas/exercise';
import { VIDEO_TITLES } from '@/lib/tutor/grounded-prose';
import {
  buildHintFacts,
  checkHintGrounding,
  chooseHintConcept,
  composeFallbackHint,
  composeStepOne,
  distinctiveKeyNames,
  generateHint,
  videoTitleForConcept,
} from './generate-hint';

function leg(overrides: Partial<AnswerKeyEntry>): AnswerKeyEntry {
  return {
    sequence: 1,
    correct_account: 'Ludhiana Woodworks',
    dr_cr: 'Dr',
    amount: 112100,
    voucher_type: 'Sales',
    gst_head: null,
    gst_rate: null,
    tds_section: null,
    tds_rate: null,
    tds_base: null,
    bill_reference: null,
    narration: null,
    concept_tags: ['gst_classification'],
    requires_source_document: false,
    source_document_type: null,
    ...overrides,
  };
}

const KEY: AnswerKey = {
  entries: [
    leg({ sequence: 1, correct_account: 'Ludhiana Woodworks', dr_cr: 'Dr', amount: 112100, bill_reference: 'INV-010' }),
    leg({ sequence: 1, correct_account: 'Sales', dr_cr: 'Cr', amount: 95000, bill_reference: 'INV-010' }),
    leg({ sequence: 1, correct_account: 'Output IGST @18%', dr_cr: 'Cr', amount: 17100, gst_head: 'IGST', gst_rate: 18, bill_reference: 'INV-010' }),
    leg({ sequence: 2, correct_account: 'Karnataka Emporium', dr_cr: 'Cr', amount: 45000, voucher_type: 'Receipt', concept_tags: ['receipt_voucher_basics'] }),
    leg({ sequence: 2, correct_account: 'HDFC Bank', dr_cr: 'Dr', amount: 45000, voucher_type: 'Receipt', concept_tags: ['receipt_voucher_basics'] }),
  ],
};

function context(overrides: Partial<HintPromptContext> = {}): HintPromptContext {
  return {
    rung: 2,
    scenario: 'Blossom Retail, June 2024.',
    transactions: [
      { sequence: 1, description: 'Sold furniture to a Punjab customer on credit, invoice INV-010.' },
      { sequence: 2, description: 'Received money from a Bengaluru customer into the bank.' },
    ],
    answerKey: KEY,
    packMode: false,
    focusConceptTag: 'gst_classification',
    ...overrides,
  };
}

function groundingFor(ctx: HintPromptContext, rung: 2 | 3) {
  return { rung, packMode: ctx.packMode, keyNames: distinctiveKeyNames(ctx.answerKey), licenseMode: ctx.licenseMode };
}

describe('step 1 is composed in code', () => {
  it('uses a real registry title and a concept question with no figures for every concept', () => {
    for (const concept of CONCEPT_TAGS) {
      const text = composeStepOne(concept, 'licensed');
      const title = videoTitleForConcept(concept);
      if (title) {
        expect(VIDEO_TITLES.has(title)).toBe(true);
        expect(text).toContain(`Watch "${title}".`);
      } else {
        expect(text).toMatch(/^Read Rulebook section /);
      }
      expect(text.replace(/Rulebook section [\d.A-C]+/, '')).not.toMatch(/\d/);
      expect(text).not.toMatch(/[—–]/);
    }
  });

  it('adds the Educational Mode posting days for educational learners only', () => {
    expect(composeStepOne('gst_classification', 'educational')).toContain('1st, 2nd or 31st');
    expect(composeStepOne('gst_classification', 'licensed')).not.toContain('31st');
  });

  it('never calls the model', async () => {
    const complete = vi.fn();
    const hint = await generateHint('learner-1', context({ rung: 1 }), { complete });
    expect(complete).not.toHaveBeenCalled();
    expect(hint).toEqual({ rung: 1, hint_text: composeStepOne('gst_classification', undefined), concept_tag: 'gst_classification' });
  });

  it('picks the focus concept, else the concept most transactions drill', () => {
    expect(chooseHintConcept({ answerKey: KEY, focusConceptTag: 'tds_classification' })).toBe('tds_classification');
    expect(chooseHintConcept({ answerKey: KEY })).toBe('receipt_voucher_basics');
  });
});

describe('checkHintGrounding, step 2 (no answer disclosure)', () => {
  const ctx = context();
  const facts = buildHintFacts(ctx, 'gst_classification');
  const check = (text: string, ids: string[]) => checkHintGrounding({ hint_text: text, fact_ids: ids }, facts, groundingFor(ctx, 2));

  it('accepts a pointer at the transaction and the rule', () => {
    expect(check('Look again at transaction 1, invoice INV-010: is the customer in another state? Rulebook 13 sets out how that decides the GST heads.', ['X1', 'R13'])).toEqual([]);
  });

  it.each([
    ['a key amount', 'Transaction 1 should carry Rs 17,100 of tax.', ['K1'], /may not state figures from the answer/],
    ['a key rate', 'Transaction 1 is taxed at 18%.', ['K1'], /may not state figures/],
    ['a key ledger name', 'Transaction 1 belongs in Output IGST @18%.', ['K1'], /names the ledger "Output IGST @18%"/],
    ['the party ledger', 'Check how you posted Ludhiana Woodworks on transaction 1.', ['X1'], /names the ledger "Ludhiana Woodworks"/],
    ['a GST head only the key gives', 'Transaction 1 needs IGST, not the split heads.', ['K1', 'X1'], /GST head IGST/],
    ['an unknown transaction', 'Look again at transaction 9.', ['X1'], /transaction 9/],
    ['an invented reference', 'Look again at INV-099.', ['X1'], /INV-099/],
    ['an em dash', 'Look again at transaction 1 — check the state.', ['X1'], /em dash/],
    ['no citations', 'Look again at transaction 1.', [], /cites no fact ids/],
  ] as const)('rejects %s', (_name, text, ids, expected) => {
    expect(check(text, [...ids]).join(' | ')).toMatch(expected);
  });
});

describe('checkHintGrounding, step 3 (full answer from cited facts)', () => {
  const ctx = context({ rung: 3 });
  const facts = buildHintFacts(ctx, 'gst_classification');
  const check = (text: string, ids: string[]) => checkHintGrounding({ hint_text: text, fact_ids: ids }, facts, groundingFor(ctx, 3));

  it('accepts the posting copied from the key fact', () => {
    expect(
      check(
        'For transaction 1 (INV-010): Dr Ludhiana Woodworks Rs 1,12,100; Cr Sales Rs 95,000; Cr Output IGST @18% Rs 17,100. The customer is in another state, so IGST applies. Why does the state decide the head?',
        ['K1', 'R13'],
      ),
    ).toEqual([]);
  });

  it.each([
    ['a wrong amount', 'Dr Ludhiana Woodworks Rs 1,21,100.', ['K1'], /121100/],
    ['a GST head the facts do not give', 'Split it into CGST and SGST.', ['K1'], /GST head (CGST|SGST)/],
    ['a TDS section no fact gives', 'Deduct TDS under 194J.', ['K1'], /TDS section 194J/],
    ['a name from another transaction', 'Post it to Karnataka Emporium.', ['K1'], /"Karnataka Emporium"/],
  ] as const)('rejects %s', (_name, text, ids, expected) => {
    expect(check(text, [...ids]).join(' | ')).toMatch(expected);
  });
});

describe('Educational Mode posting days', () => {
  const ctx = context({ rung: 2, licenseMode: 'educational' });
  const facts = buildHintFacts(ctx, 'gst_classification');
  const check = (text: string, ids: string[]) => checkHintGrounding({ hint_text: text, fact_ids: ids }, facts, groundingFor(ctx, 2));

  it('rejects any other day of the month', () => {
    expect(check('Post transaction 1 on the 15th of June.', ['X1', 'E1']).join(' | ')).toMatch(/Educational Mode.*15th/);
    expect(check('Date transaction 1 as 30-06-2024.', ['X1', 'E1']).join(' | ')).toMatch(/Educational Mode/);
  });

  it('accepts the allowed days when the rule is cited', () => {
    expect(check('Date transaction 1 on the 1st or 2nd, never mid-month.', ['X1', 'E1'])).toEqual([]);
  });
});

describe('fallbacks pass their own grounding check', () => {
  it.each([
    ['step 2 drill', context({ rung: 2 }), 2],
    ['step 3 drill', context({ rung: 3 }), 3],
    ['step 2 educational', context({ rung: 2, licenseMode: 'educational' }), 2],
    ['step 3 educational', context({ rung: 3, licenseMode: 'educational' }), 3],
    ['step 2 pack', context({ rung: 2, packMode: true }), 2],
    ['step 3 pack', context({ rung: 3, packMode: true }), 3],
  ] as const)('%s', (_name, ctx, rung) => {
    const facts = buildHintFacts(ctx, 'gst_classification');
    const text = composeFallbackHint(rung, 'gst_classification', facts, ctx);
    expect(checkHintGrounding({ hint_text: text, fact_ids: facts.map((fact) => fact.id) }, facts, groundingFor(ctx, rung))).toEqual([]);
    if (ctx.packMode || rung === 2) {
      expect(text).not.toMatch(/Ludhiana|1,12,100|17,100|Output IGST/);
    }
  });
});

describe('generateHint (bounded, grounded loop)', () => {
  const grounded = { hint_text: 'Look again at transaction 1: is the customer in another state? Rulebook 13 explains why that decides the GST heads.', fact_ids: ['X1', 'R13'] };
  const leaking = { hint_text: 'Transaction 1 belongs in Output IGST @18% for Rs 17,100.', fact_ids: ['K1'] };

  it('returns grounded model prose with the concept and step set in code', async () => {
    const complete = vi.fn().mockResolvedValue(grounded);
    const hint = await generateHint('learner-1', context(), { complete });
    expect(hint).toEqual({ rung: 2, hint_text: grounded.hint_text, concept_tag: 'gst_classification' });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('retries with the violations, then falls back after the attempt limit', async () => {
    const complete = vi.fn().mockResolvedValue(leaking);
    const hint = await generateHint('learner-1', context(), { complete });
    expect(complete).toHaveBeenCalledTimes(2);
    const retryMessages = complete.mock.calls[1][0].messages as { content: string }[];
    expect(retryMessages[retryMessages.length - 1].content).toMatch(/rejected by the fact checker/);
    expect(hint.hint_text).toMatch(/^Look again at the GST treatment on transaction 1\./);
    expect(hint.hint_text).not.toMatch(/17,100|Output IGST/);
  });

  it('treats malformed JSON as a failed attempt', async () => {
    const complete = vi.fn().mockRejectedValueOnce(new SyntaxError('Unexpected token')).mockResolvedValueOnce(grounded);
    const hint = await generateHint('learner-1', context(), { complete });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(hint.hint_text).toBe(grounded.hint_text);
  });

  it('stops waiting at the timeout and serves the fallback without a second wait', async () => {
    const complete = vi.fn().mockReturnValue(new Promise(() => {}));
    const started = Date.now();
    const hint = await generateHint('learner-1', context({ rung: 3 }), { complete, timeoutMs: 20 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(hint.rung).toBe(3);
    expect(hint.hint_text).toMatch(/^Here is the full answer/);
  });

  it('still throws a non-recoverable failure to the caller', async () => {
    const complete = vi.fn().mockRejectedValue(new Error('OpenRouter request failed (401)'));
    await expect(generateHint('learner-1', context(), { complete })).rejects.toThrow(/401/);
  });

  it('passes the license rule into the facts for educational learners', async () => {
    const complete = vi.fn().mockResolvedValue(grounded);
    await generateHint('learner-1', context({ licenseMode: 'educational' }), { complete });
    const prompt = (complete.mock.calls[0][0].messages as { content: string }[]).map((message) => message.content).join('\n');
    expect(prompt).toContain('[E1] In Tally Educational Mode');
  });
});
