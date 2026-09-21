import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnswerKey, GeneratedExercise } from '@/lib/schemas/exercise';
import {
  appendCarriedRectifications,
  describeRectification,
  validateRectification,
  type CarriedRectification,
} from '@/lib/tutor/carried-rectifications';
import { exerciseMonthForModule, runGenerationChecks } from '@/lib/tutor/generate-exercise';
import { tdsHistoryFromKeys } from '@/lib/tutor/generation-checks';
import { applyKey, openBillsOf, openingBalancesOf, replayKeys } from '@/lib/tutor/ledger-state';

const garima: CarriedRectification = {
  id: 'r1',
  learnerText:
    'On review of last month\'s Suspense clearing, only the unidentified receipt already lying in Suspense belonged to Kolkata Emporium; the balance of Rs 34,900 was never received. Reverse the excess: debit Kolkata Emporium Rs 34,900 as a New Ref against bill KE-305 (the bill is reopened for the amount still due) and credit Suspense Rs 34,900, which brings Suspense to nil.',
  legs: [
    { account: 'Kolkata Emporium', dr_cr: 'Dr', amount: 34900, bill_reference: 'KE-305 (New Ref)', narration: 'Being excess Suspense clearing reversed.' },
    { account: 'Suspense', dr_cr: 'Cr', amount: 34900, bill_reference: null, narration: 'Being excess Suspense clearing reversed.' },
  ],
};

const empty: GeneratedExercise = {
  scenario: 'June 2025: a quiet month.',
  transactions: [],
  difficulty_level: 'L2',
  variant: 'A',
  answer_key: { entries: [], opening_balances: [] },
};

const june2025 = { monthIndex: 5, year: 2025 };

describe('validateRectification', () => {
  it('accepts a balanced journal whose text figures and bill numbers are in the legs', () => {
    expect(validateRectification(garima)).toBeNull();
  });

  it('refuses unbalanced legs', () => {
    const bad = { ...garima, legs: [garima.legs[0], { ...garima.legs[1], amount: 34000 }] };
    expect(validateRectification(bad)).toMatch(/debits 34900 do not equal credits 34000/);
  });

  it('refuses a rupee figure in the text that is no leg amount', () => {
    const bad = { ...garima, learnerText: 'Suspense held only Rs 5,000; reverse Rs 34,900 against KE-305.' };
    expect(validateRectification(bad)).toMatch(/states Rs 5,000/);
  });

  it('refuses a bill number in the text that no leg references', () => {
    const bad = { ...garima, learnerText: 'Reverse Rs 34,900 wrongly cleared against KE-305 and INV-021.' };
    expect(validateRectification(bad)).toMatch(/names INV-021/);
  });

  it('refuses a dated sentence, since the batch dates the journal', () => {
    const bad = { ...garima, learnerText: 'On 06-May-2025 you cleared Rs 34,900 against KE-305; reverse it.' };
    expect(validateRectification(bad)).toMatch(/must not carry a date/);
  });

  it('refuses malformed legs', () => {
    const bad = { ...garima, legs: [{ account: '', dr_cr: 'Dr', amount: 1 }] as CarriedRectification['legs'] };
    expect(validateRectification(bad)).toMatch(/malformed/);
  });
});

describe('describeRectification', () => {
  it('dates the line and spells the journal leg by leg, debits first', () => {
    const text = describeRectification(garima, '03-Jun-2025');
    expect(text.startsWith('On 03-Jun-2025, post a rectification journal. On review')).toBe(true);
    expect(text.endsWith('Journal: Dr Kolkata Emporium Rs 34,900, bill reference KE-305 (New Ref); Cr Suspense Rs 34,900.')).toBe(true);
  });
});

describe('appendCarriedRectifications', () => {
  it('returns the batch untouched when nothing is pending', () => {
    expect(appendCarriedRectifications(empty, [], june2025)).toBe(empty);
  });

  it('appends one Journal transaction per rectification after the batch, with its legs', () => {
    const base: GeneratedExercise = {
      ...empty,
      transactions: [{ sequence: 1, description: 'On 05-Jun-2025, something.' }, { sequence: 2, description: 'On 07-Jun-2025, something else.' }],
    };
    const second: CarriedRectification = {
      id: 'r2',
      learnerText: 'Input GST was booked under the wrong head; move Rs 1,800 from Input CGST to Input IGST.',
      legs: [
        { account: 'Input IGST', dr_cr: 'Dr', amount: 1800 },
        { account: 'Input CGST', dr_cr: 'Cr', amount: 1800 },
      ],
    };
    const out = appendCarriedRectifications(base, [garima, second], june2025);
    expect(out.transactions.map((transaction) => transaction.sequence)).toEqual([1, 2, 3, 4]);
    expect(out.transactions[2].description).toContain('On 03-Jun-2025, post a rectification journal.');
    const legs3 = out.answer_key.entries.filter((entry) => entry.sequence === 3);
    expect(legs3.map((entry) => [entry.correct_account, entry.dr_cr, entry.amount, entry.bill_reference, entry.voucher_type])).toEqual([
      ['Kolkata Emporium', 'Dr', 34900, 'KE-305 (New Ref)', 'Journal'],
      ['Suspense', 'Cr', 34900, null, 'Journal'],
    ]);
    expect(legs3.every((entry) => entry.concept_tags.length === 1 && entry.concept_tags[0] === 'journal_voucher_basics' && !entry.requires_source_document)).toBe(true);
    const legs4 = out.answer_key.entries.filter((entry) => entry.sequence === 4);
    expect(legs4.map((entry) => entry.gst_head)).toEqual(['IGST', 'CGST']);
    // The input batch is not mutated.
    expect(base.transactions).toHaveLength(2);
    expect(base.answer_key.entries).toHaveLength(0);
  });

  it('throws on a rectification that cannot be carried', () => {
    const bad = { ...garima, legs: [garima.legs[0]] };
    expect(() => appendCarriedRectifications(empty, [bad], june2025)).toThrow(/Carried rectification refused/);
  });

  it('passes the generator\'s own hard checks as a batch line', () => {
    const month = exerciseMonthForModule(15);
    expect(month.label).toBe('June 2025');
    const out = appendCarriedRectifications(empty, [garima], { monthIndex: month.monthIndex, year: month.year });
    const { hard } = runGenerationChecks(out, {
      month,
      cashPosition: { cash: 5000, bank: 100000 },
      openBills: [],
      partyTaxClasses: new Map(),
      priorRefs: new Set(),
      tdsHistory: tdsHistoryFromKeys([]),
      documentsMode: true,
      companyName: 'Blossom Retail Pvt Ltd',
    });
    expect(hard).toEqual([]);
  });
});

// Garima's stored keys (local fixture, gitignored): the recorded journal
// puts Suspense at nil and reopens KE-305 for the Rs 34,900 still due.
const GARIMA = '70d15c95-cc55-47d8-b662-73acd216ded1';
const fixture = path.join(process.cwd(), 'lib', 'tutor', '__fixtures__', 'keys', `${GARIMA}.json`);

describe.skipIf(!existsSync(fixture))('Garima Suspense rectification against the stored keys', () => {
  it('replays to Suspense nil and KE-305 open for 34,900', () => {
    const rows = JSON.parse(readFileSync(fixture, 'utf8')) as { created_at: string; answer_key: AnswerKey | null }[];
    const keys = rows
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((row) => row.answer_key)
      .filter((key): key is AnswerKey => key !== null);
    const state = replayKeys(keys);
    expect(Math.round(state.balances.get('Suspense') ?? 0)).toBe(34900);
    expect(openBillsOf(state).some((bill) => bill.party === 'Kolkata Emporium')).toBe(false);

    const next = appendCarriedRectifications({ ...empty, answer_key: { entries: [], opening_balances: openingBalancesOf(state) } }, [garima], june2025);
    applyKey(state, next.answer_key);
    expect(Math.abs(state.balances.get('Suspense') ?? 0)).toBeLessThan(0.005);
    const reopened = openBillsOf(state).find((bill) => bill.party === 'Kolkata Emporium');
    expect(reopened).toMatchObject({ ref: 'KE-305', open: 34900, side: 'receivable' });
  });
});

// The saved key lists what it carried, in the same row as the key, so a
// failed stamp and a retried job step cannot carry a journal twice
// (pre-launch review, 2026-09-22).
describe('the key records the rectifications it carries', () => {
  it('stamps their ids and keeps them through the month-end journals and final dating', async () => {
    const { finalizeBatch } = await import('@/lib/tutor/generate-exercise');
    const appended = appendCarriedRectifications(empty, [garima], june2025);
    expect(appended.answer_key.carried_rectification_ids).toEqual(['r1']);
    const finalized = finalizeBatch(appended, { licenseMode: 'educational', month: june2025, cashPosition: { cash: 5000, bank: 100000 }, monthEnd: null });
    expect(finalized.errors).toEqual([]);
    expect(finalized.generated.answer_key.carried_rectification_ids).toEqual(['r1']);
    // Educational Mode moved the journal to a day Tally will save.
    expect(finalized.generated.transactions[0].description.startsWith('On 02-Jun-2025, post a rectification journal.')).toBe(true);
  });
});
